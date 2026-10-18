import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
import { Daemon } from '../../src/daemon.js'
import { loadRunnerConfig } from '../../src/config.js'
import { targetRepository, useTestGitIdentity } from './target-repo.js'

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
async function approvedTask(): Promise<string> {
  const task = await api<{ id: string }>('POST', '/api/projects/PAY/tasks', {
    title: 'Back off retries',
  })
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

    expect(ran).toBe(true)
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
