import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { buildApp } from '../../../server/src/app.js'
import { createDb } from '../../../server/src/db/client.js'
import { runMigrations } from '../../../server/src/db/migrate.js'
import type { Database } from '../../../server/src/db/schema.js'
import { BoardApi } from '../../src/api.js'
import { Daemon } from '../../src/daemon.js'
import { Sweeper } from '../../../server/src/modules/runs/sweeper.js'
import { loadRunnerConfig } from '../../src/config.js'
import { pushToMain, targetRepository, useTestGitIdentity } from './target-repo.js'

const RUNNER_KEY = 'r'.repeat(40)
const FAKE_CLAUDE = join(import.meta.dirname, '../fake/fake-claude')
const FAKE_GH = join(import.meta.dirname, '../fake/fake-gh')
const SPEC = `## Requirements
1. R1 – Retries back off
## Acceptance criteria
- AC1 (R1): Given a failure Then it retries after 1, 2 and 4 seconds
## Open questions
`
const PLAN = {
  summary: 'One step',
  confidence: 'high',
  steps: [{ title: 'Delays', requirements: ['R1'], files: ['src/retry.ts'] }],
  checks: [{ criterion: 'AC1', how: 'read the delays' }],
}
const report = (status: 'pass' | 'fail') => ({
  tool: 'save_report',
  args: { summary: status, criteria: [{ id: 'AC1', status, evidence: 'src/retry.ts' }] },
})

let container: StartedPostgreSqlContainer
let db: Kysely<Database>
let app: FastifyInstance
let base: string
let target: { remote: string; repo: string }

beforeAll(async () => {
  useTestGitIdentity()
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  db = createDb(container.getConnectionUri())
  await runMigrations(db)
  app = await buildApp({
    db,
    config: {
      databaseUrl: container.getConnectionUri(),
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['127.0.0.1', 'localhost'],
      runnerKey: RUNNER_KEY,
      logLevel: 'silent',
      prPollMs: 180_000,
      claimWaitMs: 0,
      sweepMs: 60_000,
    },
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
}, 120_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await container?.stop()
})

beforeEach(async () => {
  await sql`truncate table events, phases, artifacts, approval_requests, run_tokens, runs, specs, tasks, projects, prices restart identity cascade`.execute(
    db,
  )
  target = targetRepository()
  // The setup scenarios write a marker the fake builder's `git add -A` would otherwise commit.
  pushToMain(target.repo, { '.gitignore': 'setup.marker\n' }, 'ignore the setup marker')
  await db
    .insertInto('projects')
    .values({
      key: 'PAY',
      name: 'Payments',
      repo_path: target.repo,
      github_repo: 'owner/pay',
      base_branch: 'main',
      test_command: 'test -f src/retry.ts',
    })
    .execute()
})

/** The few response fields these scenarios read. */
interface RunJson {
  id: string
  status: string
  pr_number: number | null
  branch: string | null
  failure_reason: string | null
  fix_loops: number
  current_phase: string | null
  phases: { name: string; status: string }[]
}
interface EventJson {
  type: string
  tool: string | null
  target: string | null
  status: string | null
}
interface CostJson {
  totals: { usage: { input: number } }
  byPhase: unknown[]
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return (await response.json()) as T
}

const runs = (taskId: string) => api<RunJson[]>('GET', `/api/tasks/${taskId}/runs`)

/** A task with an approved spec and a queued run, as the owner leaves it. */
async function approvedTask(title = 'Back off retries'): Promise<string> {
  const task = await api<{ id: string }>('POST', '/api/projects/PAY/tasks', { title })
  const spec = await api<{ id: string }>('POST', `/api/tasks/${task.id}/specs`, { body_md: SPEC })
  await api('POST', `/api/specs/${spec.id}/approve`)
  return task.id
}

function daemon(script: object): Daemon {
  const dir = mkdtempSync(join(tmpdir(), 'scenario-'))
  const scriptPath = join(dir, 'script.json')
  writeFileSync(scriptPath, JSON.stringify(script))
  process.env.FAKE_CLAUDE_SCRIPT = scriptPath
  return new Daemon(
    loadRunnerConfig({
      RUNNER_KEY,
      BOARD_URL: base,
      RUNNER_ID: 'test-runner',
      CLAUDE_BIN: FAKE_CLAUDE,
      GH_BIN: FAKE_GH,
      BOARD_HOME: join(dir, 'home'),
      CLAIM_WAIT_MS: '1',
      HEARTBEAT_MS: '200',
      TEST_TIMEOUT_MS: '60000',
    }),
  )
}

const state = async (taskId: string) =>
  (await api<{ state: string }>('GET', `/api/tasks/${taskId}`)).state

describe('a delivery run end to end', () => {
  it('goes from an approved spec to a pull request, with every step on the card', async () => {
    const taskId = await approvedTask()
    const ran = await daemon({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [
        [
          { edit: 'src/retry.ts', content: 'export const delays = [1, 2, 4]\n' },
          { commit: 'back off' },
        ],
      ],
      verifier: [[report('pass')]],
    }).runOnce()

    expect(ran).toBe('review')
    expect(await state(taskId)).toBe('review')
    const [run] = await runs(taskId)
    expect(run).toMatchObject({ status: 'succeeded', pr_number: 7, branch: 'board/PAY-1-r1' })
    expect(run!.phases.map((p) => `${p.name}:${p.status}`)).toEqual([
      'plan:succeeded',
      'build:succeeded',
      'verify:succeeded',
    ])
    expect(
      execFileSync('git', ['-C', target.remote, 'show', 'board/PAY-1-r1:src/retry.ts'], {
        encoding: 'utf8',
      }),
    ).toContain('[1, 2, 4]')

    const { events } = await api<{ events: EventJson[] }>(
      'GET',
      `/api/runs/${run!.id}/events?limit=1000`,
    )
    expect(
      events.some(
        (e) => e.type === 'tool_call' && e.tool === 'Edit' && e.target === 'src/retry.ts',
      ),
    ).toBe(true)
    expect(events.some((e) => e.tool === 'test_command' && e.status === 'ok')).toBe(true)
    const costs = await api<CostJson>('GET', `/api/tasks/${taskId}/costs`)
    expect(costs.totals.usage.input).toBeGreaterThan(0)
    expect(costs.byPhase).toHaveLength(3)
  })

  it('refuses an edit outside the plan and keeps it out of the branch', async () => {
    const taskId = await approvedTask()
    await daemon({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [
        [
          { edit: 'src/retry.ts', content: 'export const delays = [1, 2, 4]\n' },
          { edit: 'src/unplanned.ts', content: 'export {}\n' },
          { commit: 'back off' },
        ],
      ],
      verifier: [[report('pass')]],
    }).runOnce()
    expect(await state(taskId)).toBe('review')
    const files = execFileSync(
      'git',
      ['-C', target.remote, 'ls-tree', '-r', '--name-only', 'board/PAY-1-r1'],
      { encoding: 'utf8' },
    )
    expect(files).not.toContain('src/unplanned.ts')
  })

  it('fails after three failed verifications, with three builds on the card', async () => {
    const taskId = await approvedTask()
    await daemon({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [
        [{ edit: 'src/retry.ts', content: 'export const delays = [1]\n' }, { commit: 'try 1' }],
        [{ edit: 'src/retry.ts', content: 'export const delays = [1, 2]\n' }, { commit: 'try 2' }],
        [
          { edit: 'src/retry.ts', content: 'export const delays = [1, 2, 3]\n' },
          { commit: 'try 3' },
        ],
      ],
      verifier: [[report('fail')]],
    }).runOnce()
    expect(await state(taskId)).toBe('failed')
    const [run] = await runs(taskId)
    expect(run).toMatchObject({
      status: 'failed',
      failure_reason: 'verify failed three times',
      fix_loops: 2,
    })
  })

  it('stops a run the owner cancels, within a heartbeat', async () => {
    const taskId = await approvedTask()
    const running = daemon({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [[{ sleep: 30_000 }]],
      verifier: [[report('pass')]],
    }).runOnce()
    while ((await runs(taskId))[0]?.current_phase !== 'build') {
      await new Promise((done) => setTimeout(done, 100))
    }
    await api('POST', `/api/tasks/${taskId}/actions/cancel`)
    await running
    expect(await state(taskId)).toBe('failed')
    const [run] = await runs(taskId)
    expect(run!.status).toBe('cancelled')
  })
})

// ── Slice 2: pauses, blocks and resumes ─────────────────────────────────────────────────────

const BOARD_CLI = join(import.meta.dirname, '../../bin/board-cli')
const builds = (content: string, message = 'back off') => [
  { edit: 'src/retry.ts', content },
  { commit: message },
]
const ASK = {
  tool: 'request_approval',
  args: {
    question: 'How many retries?',
    options: [
      { id: 'a', label: 'Three' },
      { id: 'b', label: 'Four', impact: 'Matches the email worker' },
    ],
    recommendation: 'b',
  },
}

/**
 * Daemons that share one home and one script, so a later one resumes what an earlier one left.
 * `child()` runs one as its own process, which a test can kill or stop.
 */
function fleet(script: object, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scenario-'))
  const scriptPath = join(dir, 'script.json')
  const log = join(dir, 'claude.log')
  writeFileSync(scriptPath, JSON.stringify(script))
  writeFileSync(log, '')
  const vars: Record<string, string> = {
    RUNNER_KEY,
    BOARD_URL: base,
    RUNNER_ID: 'test-runner',
    CLAUDE_BIN: FAKE_CLAUDE,
    GH_BIN: FAKE_GH,
    BOARD_HOME: join(dir, 'home'),
    CLAIM_WAIT_MS: '1',
    HEARTBEAT_MS: '200',
    TEST_TIMEOUT_MS: '60000',
    PAUSE_GRACE_MS: '400',
    STOP_GRACE_MS: '400',
    MARKER_POLL_MS: '50',
    ...env,
  }
  process.env.FAKE_CLAUDE_SCRIPT = scriptPath
  process.env.FAKE_CLAUDE_LOG = log
  const children: ChildProcess[] = []
  return {
    home: join(dir, 'home'),
    daemon: () => new Daemon(loadRunnerConfig(vars)),
    child: () => {
      // Its own process group: board-cli runs the daemon under tsx, as a child process, and a
      // runner dies only when the whole group does.
      const child = spawn(BOARD_CLI, ['daemon'], {
        env: { ...process.env, ...vars, CLAIM_WAIT_MS: '200' },
        stdio: process.env.SCENARIO_DEBUG ? 'inherit' : 'ignore',
        detached: true,
      })
      children.push(child)
      return {
        kill: (signal: NodeJS.Signals) => process.kill(-child.pid!, signal),
        exited: () =>
          child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise((done) => child.once('exit', done)),
      }
    },
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map(
          (l) =>
            JSON.parse(l) as { agent: string; resumed?: boolean; prompt?: string; denied?: string },
        ),
    stopAll: () =>
      children.forEach((c) => {
        try {
          process.kill(-c.pid!, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }),
  }
}

const task = (taskId: string) =>
  api<{
    state: string
    approval: { id: string; kind: string } | null
    block: { cause: string; stage: string; command?: string } | null
  }>('GET', `/api/tasks/${taskId}`)
const answer = (approvalId: string, body: object) =>
  api('POST', `/api/approvals/${approvalId}/answer`, body)
async function until(check: () => Promise<boolean>, what: string, ms = 20_000) {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 100))
  }
}

describe('a run that asks', () => {
  it('pauses on the builder’s question, and resumes its session with the answer', async () => {
    const taskId = await approvedTask()
    const f = fleet({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [[ASK], builds('export const delays = [1, 2, 4, 8]\n')],
      verifier: [[report('pass')]],
    })
    expect(await f.daemon().runOnce()).toBe('released')
    const waiting = await task(taskId)
    expect(waiting).toMatchObject({ state: 'needs_approval', approval: { kind: 'question' } })

    await answer(waiting.approval!.id, { option_id: 'b' })
    expect(await f.daemon().runOnce()).toBe('review')

    const [run] = await runs(taskId)
    expect(run!.phases.map((p) => `${p.name}:${p.status}`)).toEqual([
      'plan:succeeded',
      'build:succeeded',
      'verify:succeeded',
    ])
    const resumedBuild = f.calls().find((c) => c.agent === 'builder' && c.resumed === true)
    expect(resumedBuild?.prompt).toBe(
      'The owner answered your question:\n\nFour — Matches the email worker',
    )
  })

  it('waits at the plan gate, and builds once the owner approves the plan', async () => {
    const taskId = await approvedTask()
    const f = fleet({
      planner: [[{ tool: 'save_plan', args: { ...PLAN, confidence: 'medium' } }]],
      builder: [builds('export const delays = [1, 2, 4]\n')],
      verifier: [[report('pass')]],
    })
    expect(await f.daemon().runOnce()).toBe('released')
    const waiting = await task(taskId)
    expect(waiting).toMatchObject({ state: 'needs_approval', approval: { kind: 'plan' } })
    await answer(waiting.approval!.id, { option_id: 'approve' })
    expect(await f.daemon().runOnce()).toBe('review')
    expect(f.calls().filter((c) => c.agent === 'planner')).toHaveLength(1)
  })

  it('sends the plan back with changes, and gates the revised plan in the same session', async () => {
    const taskId = await approvedTask()
    const f = fleet({
      planner: [
        [{ tool: 'save_plan', args: { ...PLAN, confidence: 'medium' } }],
        [{ tool: 'save_plan', args: PLAN }],
      ],
      builder: [builds('export const delays = [1, 2, 4]\n')],
      verifier: [[report('pass')]],
    })
    await f.daemon().runOnce()
    await answer((await task(taskId)).approval!.id, { text: 'Name the delays.' })
    expect(await f.daemon().runOnce()).toBe('review')
    const planners = f.calls().filter((c) => c.agent === 'planner')
    expect(planners.map((c) => c.resumed)).toEqual([false, true])
    expect(planners[1]!.prompt).toContain('Name the delays.')
    const [run] = await runs(taskId)
    expect(run!.phases.filter((p) => p.name === 'plan')).toHaveLength(1)
  })

  it('asks before an out-of-plan edit, and makes it once the owner allows it', async () => {
    const taskId = await approvedTask()
    const f = fleet({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [
        [
          { edit: 'src/http.ts', content: 'export {}\n' },
          {
            tool: 'request_approval',
            args: {
              kind: 'out_of_plan',
              question: 'The retry needs the HTTP client.',
              files: ['src/http.ts'],
            },
          },
        ],
        [
          { edit: 'src/http.ts', content: 'export const client = {}\n' },
          ...builds('export const delays = [1, 2, 4]\n'),
        ],
      ],
      verifier: [[report('pass')]],
    })
    await f.daemon().runOnce()
    const waiting = await task(taskId)
    expect(waiting.approval?.kind).toBe('out_of_plan')
    await answer(waiting.approval!.id, { option_id: 'allow' })
    expect(await f.daemon().runOnce()).toBe('review')
    expect(
      execFileSync('git', ['-C', target.remote, 'show', 'board/PAY-1-r1:src/http.ts'], {
        encoding: 'utf8',
      }),
    ).toContain('client')
  })

  it('ends a builder that will not stop after its question, and marks its phase interrupted', async () => {
    const taskId = await approvedTask()
    const f = fleet({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [[ASK, { stubborn: true }], builds('export const delays = [1, 2, 4]\n')],
      verifier: [[report('pass')]],
    })
    const started = Date.now()
    expect(await f.daemon().runOnce()).toBe('released')
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(f.calls().some((c) => c.denied === 'mcp__board__log_step')).toBe(true)

    await answer((await task(taskId)).approval!.id, { option_id: 'a' })
    expect(await f.daemon().runOnce()).toBe('review')
    const build = await db
      .selectFrom('phases')
      .select('interrupted')
      .where('name', '=', 'build')
      .executeTakeFirstOrThrow()
    expect(build.interrupted).toBe(true)
  })

  it('cleans up the worktree of a run cancelled while it waits', async () => {
    const taskId = await approvedTask()
    const f = fleet({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [[ASK]],
    })
    await f.daemon().runOnce()
    const [run] = await runs(taskId)
    const worktree = join(f.home, 'worktrees', run!.id)
    expect(existsSync(worktree)).toBe(true)
    await api('POST', `/api/tasks/${taskId}/actions/cancel`)
    expect(await f.daemon().runOnce()).toBe('cleaned')
    expect(existsSync(worktree)).toBe(false)
    expect(await state(taskId)).toBe('failed')
  })
})

// The backlog entry slice 3 took: a builder that backgrounded a command and ended its turn lost
// the work. The guard refuses the background, so the work stays in the turn (slice 3 spec, §10).
describe('a command sent to the background', () => {
  it('is refused; the builder runs it in the foreground, and the files gate sends it round to remove what is outside the plan', async () => {
    const taskId = await approvedTask()
    const f = fleet({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [
        [
          { bash: 'echo late > background.txt', background: true },
          { bash: 'echo ran > foreground.txt' },
          { edit: 'src/retry.ts', content: 'export const delays = [1, 2, 4]\n' },
          { commit: 'back off' },
        ],
        [{ bash: 'git rm -q foreground.txt' }, { commit: 'remove foreground.txt' }],
      ],
      verifier: [[report('pass')]],
    })
    expect(await f.daemon().runOnce()).toBe('review')
    expect(await state(taskId)).toBe('review')
    expect(f.calls().some((c) => c.denied === 'Bash')).toBe(true)
    const files = execFileSync(
      'git',
      ['-C', target.remote, 'ls-tree', '-r', '--name-only', 'board/PAY-1-r1'],
      { encoding: 'utf8' },
    )
    expect(files).not.toContain('foreground.txt')
    expect(files).not.toContain('background.txt')
  })
})

describe('a run that is blocked', () => {
  it('blocks on a push the remote refuses, and pushes on Resume', async () => {
    const taskId = await approvedTask()
    const hook = join(target.remote, 'hooks', 'pre-receive')
    writeFileSync(
      hook,
      '#!/bin/sh\n[ -f pushed-once ] && exit 0\ntouch pushed-once\necho "refused once" >&2\nexit 1\n',
    )
    chmodSync(hook, 0o755)
    const f = fleet({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [builds('export const delays = [1, 2, 4]\n')],
      verifier: [[report('pass')]],
    })
    expect(await f.daemon().runOnce()).toBe('released')
    const blocked = await task(taskId)
    expect(blocked).toMatchObject({
      state: 'blocked',
      block: {
        cause: 'step_failed',
        stage: 'push',
        command: expect.stringContaining('push -u origin board/PAY-1-r1'),
      },
    })

    await api('POST', `/api/tasks/${taskId}/actions/resume`)
    expect(await f.daemon().runOnce()).toBe('review')
    expect(
      execFileSync('git', ['-C', target.remote, 'show', 'board/PAY-1-r1:src/retry.ts'], {
        encoding: 'utf8',
      }),
    ).toContain('[1, 2, 4]')
  })

  it('blocks a run whose runner died, and finishes it on Resume with a new runner', async () => {
    const taskId = await approvedTask()
    const f = fleet({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [[{ sleep: 60_000 }], builds('export const delays = [1, 2, 4]\n')],
      verifier: [[report('pass')]],
    })
    const child = f.child()
    await until(async () => (await runs(taskId))[0]?.current_phase === 'build', 'Build to start')
    await new Promise((done) => setTimeout(done, 1_000)) // the fake is sleeping in Build
    child.kill('SIGKILL')
    await child.exited()

    // The sweeper, on a clock 100 s ahead: the runner's last heartbeat is past the limit.
    let now = Date.now() + 100_000
    const sweeper = new Sweeper(db, () => new Date(now), 600_000, { warn: () => undefined })
    await sweeper.tick()
    now += 1_000
    await sweeper.tick()
    expect(await task(taskId)).toMatchObject({ state: 'blocked', block: { cause: 'runner_lost' } })

    await api('POST', `/api/tasks/${taskId}/actions/resume`)
    expect(await f.daemon().runOnce()).toBe('review')
    const builders = f.calls().filter((c) => c.agent === 'builder')
    expect(builders.map((c) => c.resumed)).toEqual([false, true])
    f.stopAll()
  })

  it('blocks a run when its daemon is stopped, and finishes it on Resume', async () => {
    const taskId = await approvedTask()
    const f = fleet({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [builds('export const delays = [1, 2, 4]\n')],
      verifier: [[{ sleep: 60_000 }], [report('pass')]],
    })
    const child = f.child()
    await until(async () => (await runs(taskId))[0]?.current_phase === 'verify', 'Verify to start')
    await new Promise((done) => setTimeout(done, 1_000))
    child.kill('SIGTERM')
    await child.exited()
    expect(await task(taskId)).toMatchObject({
      state: 'blocked',
      block: { cause: 'runner_stopped', stage: 'verify' },
    })

    await api('POST', `/api/tasks/${taskId}/actions/resume`)
    expect(await f.daemon().runOnce()).toBe('review')
    f.stopAll()
  })
})

// Slice 3: a spec run, from Draft spec to Spec review (spec §5), on Opus's recordings.
const DESCRIPTION = 'Retry failed webhooks, backing off between tries.'
const QUESTIONS = {
  tool: 'request_approval',
  args: {
    kind: 'questions',
    questions: [
      {
        question: 'How many retries?',
        options: [{ id: 'three', label: 'Three' }],
        recommendation: 'three',
      },
      { question: 'Which errors?' },
    ],
  },
}
const SAVE = { tool: 'save_spec', args: { body_md: SPEC } }

/** A Backlog task with a description, its Draft spec pressed. */
async function draftingTask(title = 'Back off retries'): Promise<string> {
  const created = await api<{ id: string }>('POST', '/api/projects/PAY/tasks', {
    title,
    description_md: DESCRIPTION,
  })
  await api('POST', `/api/tasks/${created.id}/actions/draft-spec`)
  return created.id
}
const versions = (taskId: string) =>
  api<{ version: number; status: string }[]>('GET', `/api/tasks/${taskId}/specs`)

describe('a spec run end to end', () => {
  it('asks a batch, takes the answers, saves, and leaves the card in Spec review', async () => {
    const taskId = await draftingTask()
    const f = fleet({ 'spec-writer': [[QUESTIONS], [SAVE]] })

    expect(await f.daemon().runOnce()).toBe('released')
    const waiting = await task(taskId)
    expect(waiting).toMatchObject({ state: 'needs_approval', approval: { kind: 'questions' } })
    await answer(waiting.approval!.id, {
      answers: [
        { question_id: 'q1', option_id: 'three' },
        { question_id: 'q2', text: 'Only 5xx.' },
      ],
    })
    expect(await f.daemon().runOnce()).toBe('drafted')

    expect(await state(taskId)).toBe('spec_review')
    expect(await versions(taskId)).toEqual([
      expect.objectContaining({ version: 1, status: 'draft' }),
    ])
    const [run] = await runs(taskId)
    expect(run).toMatchObject({ status: 'succeeded', branch: null })
    expect(run!.phases.map((p) => `${p.name}:${p.status}`)).toEqual(['spec:succeeded'])
    const calls = f.calls().filter((c) => c.agent === 'spec-writer')
    expect(calls.map((c) => c.resumed)).toEqual([false, true])
    expect(calls[0]?.prompt).toContain(`<description>\n${DESCRIPTION}\n</description>`)
    expect(calls[1]?.prompt).toContain('1. How many retries?')
    expect(existsSync(join(f.home, 'worktrees', run!.id))).toBe(false)
  })

  it('checks out a linked project for the spec-writer, and removes it when the run ends', async () => {
    const zlc = targetRepository()
    const [pay] = await db.selectFrom('projects').select('id').where('key', '=', 'PAY').execute()
    const linked = await db
      .insertInto('projects')
      .values({
        key: 'ZLC',
        name: 'Zellige',
        repo_path: zlc.repo,
        github_repo: 'owner/zellige',
        base_branch: 'main',
        test_command: 'true',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('project_links')
      .values({ project_id: pay!.id, linked_project_id: linked.id, note: 'the component kit' })
      .execute()
    const taskId = await draftingTask()
    const f = fleet({ 'spec-writer': [[SAVE]] })

    expect(await f.daemon().runOnce()).toBe('drafted')

    const [run] = await runs(taskId)
    const checkout = join(f.home, 'worktrees', `${run!.id}-linked`, 'ZLC')
    const [call] = f.calls().filter((c) => c.agent === 'spec-writer')
    expect(call?.prompt).toContain('<linked_projects>')
    expect(call?.prompt).toContain(checkout)
    expect(existsSync(checkout)).toBe(false)
    expect(existsSync(join(f.home, 'worktrees', `${run!.id}-linked`))).toBe(false)
    expect(
      execFileSync('git', ['-C', zlc.repo, 'worktree', 'list'], { encoding: 'utf8' }),
    ).not.toContain(checkout)
  })

  it('redrafts the latest version with the owner’s note', async () => {
    const created = await api<{ id: string }>('POST', '/api/projects/PAY/tasks', {
      title: 'Back off retries',
      description_md: DESCRIPTION,
    })
    await api('POST', `/api/tasks/${created.id}/specs`, { body_md: SPEC })
    await api('POST', `/api/tasks/${created.id}/actions/redraft`, { note: 'Say how long to wait.' })
    const f = fleet({ 'spec-writer': [[SAVE]] })

    expect(await f.daemon().runOnce()).toBe('drafted')

    const [call] = f.calls()
    expect(call?.prompt).toContain('<spec version="1">')
    expect(call?.prompt).toContain('<note>\nSay how long to wait.\n</note>')
    expect(await state(created.id)).toBe('spec_review')
    expect((await versions(created.id)).map((v) => [v.version, v.status])).toEqual([
      [2, 'draft'],
      [1, 'superseded'],
    ])
  })

  it('returns its card to Backlog, saying why, when the spec-writer saves nothing', async () => {
    const taskId = await draftingTask()
    expect(
      await fleet({ 'spec-writer': [[]] })
        .daemon()
        .runOnce(),
    ).toBe('drafted')
    expect(
      await api<{ state: string; draft_failure: string | null }>('GET', `/api/tasks/${taskId}`),
    ).toMatchObject({ state: 'backlog', draft_failure: 'the spec-writer saved no spec' })
  })

  it('is blocked when its daemon is stopped, and drafts on Resume in the same phase', async () => {
    const taskId = await draftingTask()
    const f = fleet({ 'spec-writer': [[{ sleep: 60_000 }], [SAVE]] })
    const child = f.child()
    await until(async () => (await runs(taskId))[0]?.current_phase === 'spec', 'the Spec phase')
    await new Promise((done) => setTimeout(done, 1_000))
    child.kill('SIGTERM')
    await child.exited()
    expect(await task(taskId)).toMatchObject({
      state: 'blocked',
      block: { cause: 'runner_stopped', stage: 'spec' },
    })

    await api('POST', `/api/tasks/${taskId}/actions/resume`)
    expect(await f.daemon().runOnce()).toBe('drafted')
    expect(await state(taskId)).toBe('spec_review')
    expect((await runs(taskId))[0]!.phases).toHaveLength(1)
    f.stopAll()
  })
})

// ── The project's setup command ─────────────────────────────────────────────────────────────

const setSetup = (command: string | null) =>
  db.updateTable('projects').set({ setup_command: command }).execute()
/** What the run sent as events of one kind. */
const eventsOf = async (type: string) =>
  db
    .selectFrom('events')
    .select(['tool', 'status', 'payload'])
    .where('type', '=', type as 'error')
    .orderBy('ts')
    .execute()
/** Writes a marker, and notes in the claude log that it was there: whatever claude logs after. */
const WRITES_MARKER = 'touch setup.marker && echo "setup $(ls setup.marker)" >> "$FAKE_CLAUDE_LOG"'
const rawLog = (f: { home: string }) => readFileSync(join(f.home, '..', 'claude.log'), 'utf8')

describe('the setup command', () => {
  it('reaches the runner in the claim', async () => {
    await setSetup(WRITES_MARKER)
    await approvedTask()
    const work = await new BoardApi(base, RUNNER_KEY).claim('probe', 1)
    expect(work).toMatchObject({ run: { project: { setup_command: WRITES_MARKER } } })
  })

  it('runs before the first phase of a delivery run, and sends its event', async () => {
    await setSetup(WRITES_MARKER)
    const taskId = await approvedTask()
    const f = fleet({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [builds('export const delays = [1, 2, 4]\n')],
      verifier: [[report('pass')]],
    })
    expect(await f.daemon().runOnce()).toBe('review')
    expect(rawLog(f).split('\n')[0]).toBe('setup setup.marker')
    const sent = (await eventsOf('tool_call')).filter((e) => e.tool === 'setup_command')
    expect(sent).toEqual([expect.objectContaining({ status: 'ok' })])
    expect(await state(taskId)).toBe('review')
  })

  it('runs before the spec-writer of a spec run', async () => {
    await setSetup(WRITES_MARKER)
    await draftingTask()
    const f = fleet({ 'spec-writer': [[SAVE]] })
    expect(await f.daemon().runOnce()).toBe('drafted')
    expect(rawLog(f).split('\n')[0]).toBe('setup setup.marker')
    const sent = (await eventsOf('tool_call')).filter((e) => e.tool === 'setup_command')
    expect(sent).toEqual([expect.objectContaining({ status: 'ok' })])
  })

  it('does not run, and sends nothing, when the project has none', async () => {
    await approvedTask()
    const f = fleet({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [builds('export const delays = [1, 2, 4]\n')],
      verifier: [[report('pass')]],
    })
    expect(await f.daemon().runOnce()).toBe('review')
    expect((await eventsOf('tool_call')).some((e) => e.tool === 'setup_command')).toBe(false)
  })

  it('blocks the run in prepare when it fails, and runs again on Resume', async () => {
    const flag = join(mkdtempSync(join(tmpdir(), 'flag-')), 'fixed')
    await setSetup(`[ -f ${flag} ] && exit 0; echo boom-line; exit 1`)
    const taskId = await approvedTask()
    const f = fleet({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [builds('export const delays = [1, 2, 4]\n')],
      verifier: [[report('pass')]],
    })
    expect(await f.daemon().runOnce()).toBe('released')
    expect(await task(taskId)).toMatchObject({
      state: 'blocked',
      block: { cause: 'step_failed', stage: 'prepare', command: expect.stringContaining('boom') },
    })
    const errors = await eventsOf('error')
    expect(errors.at(-1)!.payload).toMatchObject({
      cause: 'step_failed',
      output: expect.stringContaining('boom-line'),
    })
    expect(f.calls()).toHaveLength(0)
    const checkpoints = await eventsOf('checkpoint')
    expect(checkpoints.at(-1)!.payload).toMatchObject({ stage: 'prepare' })

    writeFileSync(flag, '')
    await api('POST', `/api/tasks/${taskId}/actions/resume`)
    expect(await f.daemon().runOnce()).toBe('review')
    expect(f.calls().length).toBeGreaterThan(0)
  })

  it('kills a setup command that outlives the timeout, and blocks the run', async () => {
    await setSetup('echo started; sleep 30')
    const taskId = await approvedTask()
    const f = fleet({ planner: [[{ tool: 'save_plan', args: PLAN }]] }, { TEST_TIMEOUT_MS: '500' })
    expect(await f.daemon().runOnce()).toBe('released')
    expect(await task(taskId)).toMatchObject({
      state: 'blocked',
      block: { cause: 'step_failed', stage: 'prepare' },
    })
    const sent = (await eventsOf('tool_call')).find((e) => e.tool === 'setup_command')
    expect(sent).toMatchObject({ status: 'error', payload: { timed_out: true } })
    expect(f.calls()).toHaveLength(0)
  })
})
