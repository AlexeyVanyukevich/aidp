import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApiError, type BoardApi } from '../../src/api.js'
import type { ArtifactView, Checkpoint, RunnerEvent, RunWork, Work } from '../../src/contract.js'
import {
  carryOut,
  cleanUp,
  INTERRUPTED,
  type DeliveryDeps,
  type Phases,
} from '../../src/delivery.js'
import { Git, GitError } from '../../src/git.js'
import type { PhaseRecord, StepResult } from '../../src/phases/phase.js'
import { EventSink } from '../../src/sink.js'

const RUN: RunWork = {
  id: '00000000-0000-4000-8000-000000000001',
  number: 2,
  kind: 'delivery',
  spec_version: 1,
  note: null,
  task: { id: 't', key: 'PAY-1', title: 'Retry', description_md: '', budget_usd: null },
  spec: {
    version: 1,
    body_md: '## Requirements\n1. R1 – x',
    criteria: [{ id: 'AC1', requirements: ['R1'], text: 'x' }],
  },
  project: {
    key: 'PAY',
    repo_path: '/repo',
    github_repo: 'owner/pay',
    base_branch: 'main',
    test_command: 'npm test',
    setup_command: null,
  },
}
const RUN_DIR = (home: string) => join(home, 'runs', RUN.id)
const START: Work = { kind: 'start', run: RUN }
const BRANCH = 'board/PAY-1-r2'

/** What one process of a phase does. */
type Act = 'ok' | 'paused' | 'cancelled' | 'shutdown' | 'fails' | 'gone'
type Verdict = 'pass' | 'fail' | 'owner-pass' | 'owner-fail' | 'no-report'
interface Script {
  /** Per phase and attempt, what each of its processes does in turn: `{ 'build-1': ['paused', 'ok'] }`. */
  acts?: Record<string, Act[]>
  /** The confidence of each plan the planner saves, in turn. */
  confidence?: ('high' | 'medium')[]
  savesPlan?: boolean
  commits?: number[]
  verdicts?: Verdict[]
  /** What each push does, in turn. */
  push?: ('ok' | 'fails')[]
  prOpen?: boolean
  hasMessages?: boolean
  worktreeGone?: boolean
  /** What the board answers to the gate's event, instead of accepting it. */
  refuse?: ApiError
  /** The worktree as a resumed run finds it. */
  initial?: { committed?: string[]; uncommitted?: string[] }
  /** The worktree after each build that ends ok, in turn: its committed and uncommitted paths. */
  trees?: { committed?: string[]; uncommitted?: string[] }[]
  /** Paths each run of the test command writes, in turn. */
  testWrites?: string[][]
  /** The 1-based calls of `changedPaths` that fail with a GitError. */
  changedFails?: number[]
  /** Paths the worktree holds once setup has run. */
  afterSetup?: string[]
  /** The worktree's HEAD once each Verify that ends ok has run, in turn. */
  verifyHeads?: string[]
  setupCommand?: string
}

function harness(script: Script) {
  const sent: RunnerEvent[] = []
  const artifacts: ArtifactView[] = []
  const calls: string[] = []
  const gitCalls: string[] = []
  /** Where each push and pull request was made. */
  const writes: string[] = []
  const used: Record<string, number> = {}
  let plans = 0
  let verifies = 0
  let builds = 0
  let pushes = 0
  let changedCalls = 0
  let tests = 0
  let setupRan = false
  let headNow = 'abc123'
  /** The commands the runner ran as the project's test command. */
  const testRuns: string[] = []
  const runResult = {
    exitCode: 0,
    timedOut: false,
    output: 'tests ok',
    truncated: false,
    durationMs: 5,
  }
  const tree = {
    committed: [...(script.initial?.committed ?? [])],
    uncommitted: [...(script.initial?.uncommitted ?? [])],
  }

  const api = {
    issueToken: async () => 'token',
    retire: async () => undefined,
    sendEvents: async (_t: string, events: RunnerEvent[]) => {
      if (script.refuse !== undefined && events.some((e) => e.type === 'approval_requested'))
        throw script.refuse
      sent.push(...events)
      return events.length
    },
    getRun: async () => ({ id: RUN.id, status: 'running', phases: [], artifacts }),
    phaseHasMessages: async () => script.hasMessages ?? false,
  } as unknown as BoardApi

  const act = (record: PhaseRecord): StepResult => {
    const key = `${record.phase}-${record.attempt}`
    const n = used[key] ?? 0
    used[key] = n + 1
    const what = script.acts?.[key]?.[n] ?? 'ok'
    if (what === 'ok' && record.phase === 'plan' && script.savesPlan !== false) {
      artifacts.push({
        id: `plan-${++plans}`,
        kind: 'plan',
        phase_id: record.phaseId,
        body_md: '1. Backoff',
        uri: null,
        data: {
          summary: 's',
          confidence: script.confidence?.[plans - 1] ?? 'high',
          steps: [{ title: 'b', requirements: ['R1'], files: ['src/retry.ts'] }],
          checks: [{ criterion: 'AC1', how: 'test' }],
        },
      })
    }
    if (what === 'ok' && record.phase === 'build') {
      builds += 1
      const next = script.trees?.[builds - 1]
      if (next !== undefined) {
        tree.committed = next.committed ?? []
        tree.uncommitted = next.uncommitted ?? []
      }
    }
    if (what === 'ok' && record.phase === 'verify') {
      headNow = script.verifyHeads?.[verifies] ?? headNow
      const verdict = script.verdicts?.[verifies++] ?? 'pass'
      if (verdict !== 'no-report')
        artifacts.push({
          id: `report-${verifies}`,
          kind: 'verify_report',
          phase_id: record.phaseId,
          body_md: `| AC1 | ${verdict} |`,
          uri: null,
          data: {
            summary: 's',
            criteria:
              verdict === 'owner-pass'
                ? [
                    { id: 'AC1', status: 'pass', evidence: 'e' },
                    { id: 'AC2', status: 'owner', evidence: 'e' },
                  ]
                : verdict === 'owner-fail'
                  ? [
                      { id: 'AC1', status: 'fail', evidence: 'e' },
                      { id: 'AC2', status: 'owner', evidence: 'e' },
                    ]
                  : [{ id: 'AC1', status: verdict, evidence: 'e' }],
          },
        })
    }
    return {
      record: { ...record, summary: `${key} done` },
      ok: what === 'ok' || what === 'paused',
      stopped: what === 'paused' || what === 'cancelled' || what === 'shutdown' ? what : 'no',
      sessionGone: what === 'gone',
    }
  }
  const handoffs: Record<string, string> = {}
  const phases: Phases = {
    start: async (input, _deps, ids) => {
      calls.push(`start ${input.phase}-${input.attempt}`)
      handoffs[`${input.phase}-${input.attempt}`] = input.handoff
      return act({
        runId: RUN.id,
        phaseId: ids.phaseId,
        phase: input.phase,
        attempt: input.attempt,
        sessionId: ids.sessionId,
        baseline: {},
        reported: {},
        interrupted: false,
        summary: '',
      })
    },
    resume: async (record, message) => {
      calls.push(`resume ${record.phase}-${record.attempt}: ${message}`)
      return act(record)
    },
    restart: async (record) => {
      calls.push(`restart ${record.phase}-${record.attempt}`)
      return act(record)
    },
    end: async (record, ok) => {
      calls.push(`end ${record.phase}-${record.attempt} ${ok ? 'ok' : 'failed'}`)
    },
  }

  const git = {
    prepareWorktree: async (_r: string, _b: string, branch: string) => {
      gitCalls.push(`worktree ${branch}`)
    },
    newCommits: async () => script.commits?.[builds - 1] ?? 1,
    diff: async () => '+change',
    head: async () => headNow,
    changedPaths: async () => {
      changedCalls += 1
      if (script.changedFails?.includes(changedCalls))
        throw new GitError('git -C wt merge-base HEAD origin/main', 'fatal: bad revision')
      return {
        mergeBase: 'b'.repeat(40),
        committed: [...tree.committed],
        uncommitted: [...tree.uncommitted],
      }
    },
    currentBranch: async () => BRANCH,
    deleteBranch: async () => {
      gitCalls.push('delete branch')
    },
    push: async (dir: string, branch: string) => {
      writes.push(`push in ${dir}`)
      const what = script.push?.[pushes++] ?? 'ok'
      if (what === 'fails') throw new GitError(`git push -u origin ${branch}`, 'rejected')
      gitCalls.push(`push ${branch}`)
    },
    findPr: async () => {
      gitCalls.push('find pr')
      return script.prOpen === true
        ? { number: 5, url: 'https://github.com/owner/pay/pull/5' }
        : null
    },
    createPr: async (dir: string, pr: { githubRepo: string; base: string }) => {
      writes.push(`create pr in ${dir} for ${pr.githubRepo} on ${pr.base}`)
      gitCalls.push('create pr')
      return { number: 9, url: 'https://github.com/owner/pay/pull/9' }
    },
    removeWorktree: async (repo: string) => {
      gitCalls.push(repo === '/repo' ? 'remove' : `remove linked ${repo}`)
    },
    prepareDetachedWorktree: async (repo: string, base: string, dir: string) => {
      gitCalls.push(`linked ${repo} ${base} ${dir}`)
    },
    pruneWorktrees: async () => undefined,
  } as unknown as Git

  const home = mkdtempSync(join(tmpdir(), 'home-'))
  if (script.worktreeGone !== true) mkdirSync(join(home, 'worktrees', RUN.id), { recursive: true })
  const shutdown = new AbortController()
  const deps: DeliveryDeps = {
    api,
    git,
    sink: new EventSink(api, join(home, 'events.ndjson'), () => 'token'),
    setToken: () => undefined,
    phases,
    runTests: async (command) => {
      if (command === script.setupCommand && !setupRan) {
        setupRan = true
        tree.uncommitted = [...(script.afterSetup ?? [])]
      } else {
        tree.uncommitted = [...tree.uncommitted, ...(script.testWrites?.[tests] ?? [])]
        tests += 1
        testRuns.push(command)
      }
      return runResult
    },
    config: {
      boardUrl: 'http://b',
      runnerKey: 'k',
      runnerId: 'r',
      claudeBin: 'claude',
      ghBin: 'gh',
      home,
      testTimeoutMs: 1000,
      claimWaitMs: 1,
      heartbeatMs: 1000,
      pauseGraceMs: 1000,
      stopGraceMs: 1000,
      markerPollMs: 50,
    },
    signal: new AbortController().signal,
    shutdown: shutdown.signal,
  }
  return {
    deps,
    sent,
    artifacts,
    calls,
    gitCalls,
    writes,
    handoffs,
    home,
    testRuns,
    changed: () => changedCalls,
    of: (type: string) => sent.filter((e) => e.type === type),
    runEnd: () => sent.find((e) => e.type === 'run_end'),
    checkpoints: () =>
      sent.filter((e) => e.type === 'checkpoint').map((e) => e.payload as unknown as Checkpoint),
  }
}

const checkpoint = (stage: Checkpoint['stage'], attempt: number, phase?: string): Checkpoint => ({
  stage,
  attempt,
  phase_id: phase ?? null,
  session: phase === undefined ? null : { id: 's-1', baseline: {}, reported: {} },
  head: 'abc123',
  plan_artifact_id: 'plan-1',
  failing_report_id: null,
})
const resume = (
  cp: Checkpoint,
  message: string | null,
  allowed: string[] = ['src/retry.ts'],
): Work => ({
  kind: 'resume',
  run: RUN,
  checkpoint: cp,
  message,
  allowed_files: allowed,
})

/** Seeds the plan a resumed run works from, as the board would hand it back. */
function withPlan(h: ReturnType<typeof harness>) {
  h.artifacts.push({
    id: 'plan-1',
    kind: 'plan',
    phase_id: 'plan-phase',
    body_md: '1. Backoff',
    uri: null,
    data: {
      summary: 's',
      confidence: 'high',
      steps: [{ title: 'b', requirements: ['R1'], files: ['src/retry.ts'] }],
      checks: [],
    },
  })
  return h
}

describe('a run carried out from the start, as slice 1 did', () => {
  it('plans, builds, verifies, and opens the pull request', async () => {
    const h = harness({})
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('review')
    expect(h.calls).toEqual([
      'start plan-1',
      'end plan-1 ok',
      'start build-1',
      'end build-1 ok',
      'start verify-1',
      'end verify-1 ok',
    ])
    expect(h.gitCalls).toEqual([
      `worktree ${BRANCH}`,
      `push ${BRANCH}`,
      'find pr',
      'create pr',
      'remove',
    ])
    expect(h.runEnd()).toMatchObject({
      payload: { outcome: 'review', pr_number: 9, branch: BRANCH },
    })
    expect(h.checkpoints().map((c) => c.stage)).toEqual(
      expect.arrayContaining(['prepare', 'plan', 'build', 'tests', 'verify', 'push', 'pr']),
    )
    expect(readFileSync(join(h.home, 'runs', RUN.id, 'allowed-files.json'), 'utf8')).toBe(
      '["src/retry.ts"]',
    )
  })

  it('hands a failing report to the next build, and gives up after the third', async () => {
    const h = harness({ verdicts: ['fail', 'fail', 'fail'] })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('failed')
    expect(h.calls.filter((c) => c.startsWith('start'))).toEqual([
      'start plan-1',
      'start build-1',
      'start verify-1',
      'start build-2',
      'start verify-2',
      'start build-3',
      'start verify-3',
    ])
    expect(h.handoffs['build-2']).toContain('<verify_report>')
    expect(h.runEnd()).toMatchObject({
      payload: { outcome: 'failed', reason: 'verify failed three times' },
    })
  })

  it('opens the pull request when the report holds pass and owner and no fail', async () => {
    const h = harness({ verdicts: ['owner-pass'] })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('review')
    expect(h.calls.filter((c) => c.startsWith('start'))).toEqual([
      'start plan-1',
      'start build-1',
      'start verify-1',
    ])
    expect(h.gitCalls).toContain(`push ${BRANCH}`)
    expect(h.gitCalls).toContain('create pr')
  })

  it('still fails after the third report that holds an owner and a fail', async () => {
    const h = harness({ verdicts: ['owner-fail', 'owner-fail', 'owner-fail'] })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('failed')
    expect(h.calls.filter((c) => c.startsWith('start verify'))).toHaveLength(3)
    expect(h.runEnd()).toMatchObject({
      payload: { outcome: 'failed', reason: 'verify failed three times' },
    })
  })

  it('counts a build with no commit as a failed verify, without running Verify', async () => {
    const h = harness({ commits: [0, 1] })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('review')
    expect(h.calls.filter((c) => c.startsWith('start'))).toEqual([
      'start plan-1',
      'start build-1',
      'start build-2',
      'start verify-2',
    ])
    expect(h.handoffs['build-2']).toContain('made no commit')
  })

  it.each([
    ['a planner that saved no plan', { savesPlan: false }, 'the planner saved no plan'],
    [
      'a plan phase that failed',
      { acts: { 'plan-1': ['fails' as const] } },
      'the plan phase failed',
    ],
    [
      'a verifier that saved no report',
      { verdicts: ['no-report' as const] },
      'the verifier saved no report',
    ],
  ])('fails the run on %s, saying why', async (_name, script, reason) => {
    const h = harness(script)
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('failed')
    expect(h.runEnd()).toMatchObject({ payload: { outcome: 'failed', reason } })
    expect(h.gitCalls.at(-1)).toBe('remove')
  })

  it('ends a cancelled run as cancelled', async () => {
    const h = harness({ acts: { 'build-1': ['cancelled'] } })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('cancelled')
    expect(h.runEnd()).toMatchObject({ payload: { outcome: 'cancelled' } })
  })
})

describe('a run holding a copied plan', () => {
  const KEPT: RunWork = { ...RUN, kept_plan: { artifact_id: 'plan-1', from_run: 1 } }
  const kept = (h: ReturnType<typeof harness>) => {
    withPlan(h)
    return { kind: 'start', run: KEPT } as Extract<Work, { kind: 'start' }>
  }

  it('AC6: starts no planner and raises no gate; Build follows prepare', async () => {
    const h = harness({})
    expect(await carryOut(kept(h), h.deps)).toBe('review')
    expect(h.calls.filter((c) => c.startsWith('start'))).toEqual([
      'start build-1',
      'start verify-1',
    ])
    expect(h.calls.some((c) => c.includes('plan-'))).toBe(false)
    expect(h.of('approval_requested')).toEqual([])
    expect(h.handoffs['build-1']).toContain('<plan>')
    expect(readFileSync(join(h.home, 'runs', RUN.id, 'allowed-files.json'), 'utf8')).toBe(
      '["src/retry.ts"]',
    )
    expect(h.checkpoints().every((c) => c.plan_artifact_id === 'plan-1')).toBe(true)
  })

  it('AC7: a resume from before Build goes on in Build with the plan, no planner', async () => {
    const h = harness({})
    withPlan(h)
    const work: Work = {
      kind: 'resume',
      run: KEPT,
      checkpoint: { ...checkpoint('prepare', 1), plan_artifact_id: 'plan-1' },
      message: INTERRUPTED,
      allowed_files: ['src/retry.ts'],
    }
    expect(await carryOut(work as Extract<Work, { kind: 'resume' }>, h.deps)).toBe('review')
    expect(h.calls.filter((c) => c.startsWith('start'))[0]).toBe('start build-1')
    expect(h.of('approval_requested')).toEqual([])
  })
})

describe('a re-planning run', () => {
  it('AC9: hands the planner the previous plans, and a medium plan still meets the gate', async () => {
    const h = harness({ confidence: ['medium'] })
    const work = {
      kind: 'start',
      run: { ...RUN, previous_plans: [{ run: 1, accepted: true, body_md: 'old plan' }] },
    } as Extract<Work, { kind: 'start' }>
    await carryOut(work, h.deps)
    expect(h.handoffs['plan-1']).toContain(
      '<previous_plan run="1" accepted="yes">\nold plan\n</previous_plan>',
    )
    expect(h.handoffs['plan-1']).not.toContain('<plan>')
    expect(h.of('approval_requested')).toHaveLength(1)
  })
})

describe('a re-planning run with plan answers', () => {
  const answers = [{ run: 1, approved: false, text: 'keep tests in tests/unit' }]
  it('AC10: only the planner is handed the answers', async () => {
    const h = harness({})
    const work = { kind: 'start', run: { ...RUN, plan_answers: answers } } as Extract<
      Work,
      { kind: 'start' }
    >
    await carryOut(work, h.deps)
    expect(h.handoffs['plan-1']).toContain(
      '<plan_answer run="1" approved="no">\nkeep tests in tests/unit\n</plan_answer>',
    )
    expect(h.handoffs['build-1']).not.toContain('<plan_answer')
  })

  it('AC8: a claim without the field gives a handoff without the tag', async () => {
    const h = harness({})
    await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)
    expect(h.handoffs['plan-1']).not.toContain('<plan_answer')
  })
})

describe('pausing and resuming', () => {
  it('releases a run that pauses in Build: no phase end, no run end, the worktree kept', async () => {
    const h = harness({ acts: { 'build-1': ['paused'] } })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('released')
    expect(h.calls).toEqual(['start plan-1', 'end plan-1 ok', 'start build-1'])
    expect(h.runEnd()).toBeUndefined()
    expect(h.gitCalls).not.toContain('remove')
    const last = h.checkpoints().at(-1)!
    expect(last).toMatchObject({ stage: 'build', attempt: 1, plan_artifact_id: 'plan-1' })
    expect(last.session).toMatchObject({ id: expect.any(String) })
  })

  it('resumes Build with the answer and carries on to a pull request', async () => {
    const h = withPlan(harness({}))
    const outcome = await carryOut(
      resume(
        checkpoint('build', 1, 'build-phase'),
        'The owner answered your question:\n\nBlue',
      ) as Extract<Work, { kind: 'resume' }>,
      h.deps,
    )
    expect(outcome).toBe('review')
    expect(h.calls).toEqual([
      'resume build-1: The owner answered your question:\n\nBlue',
      'end build-1 ok',
      'start verify-1',
      'end verify-1 ok',
    ])
    expect(h.gitCalls).not.toContain(`worktree ${BRANCH}`)
  })

  it('writes the approved migrations beside the allowed files on resume', async () => {
    const h = withPlan(harness({}))
    const M = 'server/src/db/migrations/004_x.ts'
    const work = {
      ...resume(checkpoint('build', 1, 'build-phase'), 'The owner allowed the migration.', [
        'src/retry.ts',
        M,
      ]),
      approved_migrations: [M],
    } as Extract<Work, { kind: 'resume' }>
    await carryOut(work, h.deps)
    const dir = join(h.home, 'runs', RUN.id)
    expect(JSON.parse(readFileSync(join(dir, 'approved-migrations.json'), 'utf8'))).toEqual([M])
    expect(JSON.parse(readFileSync(join(dir, 'allowed-files.json'), 'utf8'))).toContain(M)
  })

  it('writes the base branch to the run directory on start and on resume', async () => {
    const started = withPlan(harness({}))
    await carryOut(START as Extract<Work, { kind: 'start' }>, started.deps)
    expect(readFileSync(join(started.home, 'runs', RUN.id, 'base-branch.txt'), 'utf8')).toBe('main')
    const resumed = withPlan(harness({}))
    await carryOut(
      resume(checkpoint('build', 1, 'build-phase'), 'Go on.', ['src/retry.ts']) as Extract<
        Work,
        { kind: 'resume' }
      >,
      resumed.deps,
    )
    expect(readFileSync(join(resumed.home, 'runs', RUN.id, 'base-branch.txt'), 'utf8')).toBe('main')
  })

  it('stops at the plan gate when the planner is not confident', async () => {
    const h = harness({ confidence: ['medium'] })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('released')
    expect(h.calls).toEqual(['start plan-1'])
    expect(h.of('approval_requested')).toEqual([
      expect.objectContaining({
        phase_id: expect.any(String),
        payload: expect.objectContaining({
          approval_id: expect.any(String),
          kind: 'plan',
          context_md: '1. Backoff',
        }),
      }),
    ])
  })

  it('fails the run in plain words when the board refuses the plan gate', async () => {
    const refusal = new ApiError(
      400,
      'POST /api/runner/events answered 400: {"error":"validation_error"}',
      {
        error: 'validation_error',
        details: { findings: [{ field: 'context_md', code: 'too_long' }] },
      },
    )
    const h = harness({ confidence: ['medium'], refuse: refusal })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('failed')
    expect(h.calls).toContain('end plan-1 failed')
    const reason = String(h.runEnd()?.payload.reason)
    expect(reason).toBe('The board refused the plan gate: context_md is too long.')
    expect(reason).not.toContain('answered 400')
    expect(reason).not.toContain('{')
  })

  it('fails the run with a bare sentence when the refusal names nothing', async () => {
    const h = harness({ confidence: ['medium'], refuse: new ApiError(400, 'answered 400: no') })
    await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)
    expect(h.runEnd()).toMatchObject({
      payload: { outcome: 'failed', reason: 'The board refused the plan gate.' },
    })
  })

  it('starts Build once the owner approves the plan', async () => {
    const h = withPlan(harness({}))
    expect(
      await carryOut(
        resume(checkpoint('plan', 1, 'plan-phase'), null) as Extract<Work, { kind: 'resume' }>,
        h.deps,
      ),
    ).toBe('review')
    expect(h.calls.slice(0, 2)).toEqual(['end plan-1 ok', 'start build-1'])
  })

  it('resumes the planner with the changes the owner asks for, then gates the new plan', async () => {
    const h = withPlan(harness({ confidence: ['high'] }))
    expect(
      await carryOut(
        resume(checkpoint('plan', 1, 'plan-phase'), 'Split step 2.') as Extract<
          Work,
          { kind: 'resume' }
        >,
        h.deps,
      ),
    ).toBe('review')
    expect(h.calls.slice(0, 3)).toEqual([
      'resume plan-1: Split step 2.',
      'end plan-1 ok',
      'start build-1',
    ])
  })
})

describe('blocks', () => {
  it('blocks the run on a push git refused, with the command and its output', async () => {
    const h = harness({ push: ['fails'] })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('released')
    expect(h.of('error').at(-1)).toMatchObject({
      payload: {
        blocks: true,
        cause: 'step_failed',
        stage: 'push',
        command: `git push -u origin ${BRANCH}`,
        output: 'rejected',
      },
    })
    expect(h.runEnd()).toBeUndefined()
  })

  it('retries the push on Resume, and opens the pull request', async () => {
    const h = withPlan(harness({}))
    expect(
      await carryOut(
        resume(checkpoint('push', 1), INTERRUPTED) as Extract<Work, { kind: 'resume' }>,
        h.deps,
      ),
    ).toBe('review')
    expect(h.gitCalls).toEqual([`push ${BRANCH}`, 'find pr', 'create pr', 'remove'])
  })

  it('takes the pull request a stopped run already opened, rather than creating another', async () => {
    const h = withPlan(harness({ prOpen: true }))
    expect(
      await carryOut(
        resume(checkpoint('pr', 1), INTERRUPTED) as Extract<Work, { kind: 'resume' }>,
        h.deps,
      ),
    ).toBe('review')
    expect(h.gitCalls).not.toContain('create pr')
    expect(h.runEnd()).toMatchObject({ payload: { pr_number: 5 } })
  })

  it('blocks the run when the daemon stops it mid-Verify', async () => {
    const h = harness({ acts: { 'verify-1': ['shutdown'] } })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('released')
    expect(h.of('error').at(-1)).toMatchObject({
      payload: { blocks: true, cause: 'runner_stopped', stage: 'verify' },
    })
  })

  it('fails a resume whose worktree is gone', async () => {
    const h = withPlan(harness({ worktreeGone: true }))
    expect(
      await carryOut(
        resume(checkpoint('build', 1, 'b'), INTERRUPTED) as Extract<Work, { kind: 'resume' }>,
        h.deps,
      ),
    ).toBe('failed')
    expect(h.runEnd()).toMatchObject({ payload: { reason: "the run's worktree is gone" } })
  })

  it('starts a phase again when its session is gone and held no message', async () => {
    const h = withPlan(harness({ acts: { 'build-1': ['gone', 'ok'] }, hasMessages: false }))
    expect(
      await carryOut(
        resume(checkpoint('build', 1, 'b'), INTERRUPTED) as Extract<Work, { kind: 'resume' }>,
        h.deps,
      ),
    ).toBe('review')
    expect(h.calls.slice(0, 3)).toEqual([
      `resume build-1: ${INTERRUPTED}`,
      'restart build-1',
      'end build-1 ok',
    ])
  })

  it('fails a run whose session is gone with its messages', async () => {
    const h = withPlan(harness({ acts: { 'build-1': ['gone'] }, hasMessages: true }))
    expect(
      await carryOut(
        resume(checkpoint('build', 1, 'b'), INTERRUPTED) as Extract<Work, { kind: 'resume' }>,
        h.deps,
      ),
    ).toBe('failed')
    expect(h.runEnd()).toMatchObject({
      payload: { reason: "the run's Claude Code session is gone; Re-run starts again from Plan" },
    })
  })
})

describe('cleaning up', () => {
  it('removes the worktree of a run cancelled while paused', async () => {
    // The board knows no path for a run that never ended: the runner's own convention finds it.
    const h = harness({})
    await cleanUp(
      { kind: 'cleanup', run: { id: RUN.id, repo_path: '/repo', worktree_path: null } },
      h.deps,
    )
    expect(h.gitCalls).toEqual(['remove'])
  })
})

describe('a delivery run of a project that links another', () => {
  const ZLC = {
    key: 'ZLC',
    name: 'Zellige',
    note: 'the kit',
    repo_path: '/zlc',
    github_repo: 'owner/zellige',
    base_branch: 'main',
  }
  const LINKED: Work = { kind: 'start', run: { ...RUN, links: [ZLC] } }

  it('AC19: pushes and opens its pull request only for its own project', async () => {
    const h = harness({})
    expect(await carryOut(LINKED, h.deps)).toBe('review')
    const linkedPath = join(h.home, 'worktrees', `${RUN.id}-linked`, 'ZLC')
    expect(h.gitCalls).toContain(`linked /zlc main ${linkedPath}`)
    const worktree = join(h.home, 'worktrees', RUN.id)
    expect(h.writes).toEqual([
      `push in ${worktree}`,
      `create pr in ${worktree} for owner/pay on main`,
    ])
    expect(h.gitCalls).toContain('remove linked /zlc')
  })

  it('makes the checkout in prepare, before any phase, and makes none without links', async () => {
    const withLinks = harness({})
    await carryOut(LINKED, withLinks.deps)
    expect(withLinks.gitCalls.findIndex((c) => c.startsWith('linked'))).toBe(1)
    const without = harness({})
    await carryOut(START, without.deps)
    expect(without.gitCalls.some((c) => c.startsWith('linked'))).toBe(false)
  })

  it('AC12: a cleanup claimed after a Cancel removes the linked checkouts too', async () => {
    const h = harness({})
    const runDir = join(h.home, 'runs', RUN.id)
    mkdirSync(runDir, { recursive: true })
    const path = join(h.home, 'worktrees', `${RUN.id}-linked`, 'ZLC')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(runDir, 'linked.json'), JSON.stringify([{ ...ZLC, path }]))
    await cleanUp(
      { kind: 'cleanup', run: { id: RUN.id, repo_path: '/repo', worktree_path: null } },
      h.deps,
    )
    expect(h.gitCalls).toEqual(['remove linked /zlc', 'remove'])
    expect(existsSync(path)).toBe(false)
  })
})

describe('the files gate', () => {
  const start = START as Extract<Work, { kind: 'start' }>
  const EXTRA = { committed: ['src/extra.ts'] }
  const resumeAt = (cp: Checkpoint, allowed?: string[]) =>
    resume(cp, INTERRUPTED, allowed) as Extract<Work, { kind: 'resume' }>
  const gateFailure = (attempt: number): Checkpoint => ({
    ...checkpoint('build', attempt),
    failing_report_id: 'files_gate',
  })

  it('AC10: a commit outside the plan skips the test command and sends Build round again', async () => {
    const h = harness({ trees: [EXTRA, {}] })
    expect(await carryOut(start, h.deps)).toBe('review')
    expect(h.calls.filter((c) => c.startsWith('start'))).toEqual([
      'start plan-1',
      'start build-1',
      'start build-2',
      'start verify-2',
    ])
    expect(h.testRuns).toHaveLength(1)
    expect(readFileSync(join(RUN_DIR(h.home), 'files-gate-report.md'), 'utf8')).toContain(
      'src/extra.ts',
    )
    const second = h.checkpoints().find((c) => c.stage === 'build' && c.attempt === 2)
    expect(second).toMatchObject({ failing_report_id: 'files_gate' })
    for (const text of ['src/extra.ts', 'not in the plan', 'out_of_plan', 'migration'])
      expect(h.handoffs['build-2']).toContain(text)
  })

  it('AC11: an untracked file and no commit hands the gate report, not the no-commit text', async () => {
    const h = harness({ commits: [0, 1], trees: [{ uncommitted: ['src/extra.ts'] }, {}] })
    expect(await carryOut(start, h.deps)).toBe('review')
    expect(h.handoffs['build-2']).toContain('src/extra.ts')
    expect(h.handoffs['build-2']).not.toContain('made no commit')
  })

  it('AC12: once the owner allows the file, the test command runs and Verify follows', async () => {
    const h = withPlan(harness({ initial: EXTRA }))
    const allowed = ['src/retry.ts', 'src/extra.ts']
    const at = { ...checkpoint('tests', 2), failing_report_id: 'files_gate' }
    expect(await carryOut(resumeAt(at, allowed), h.deps)).toBe('review')
    expect(h.calls).toContain('start verify-2')
    expect(h.testRuns).toHaveLength(1)
  })

  it('AC13: a Build resumed after a refusal is handed the report file, with no git command', async () => {
    const h = withPlan(harness({ acts: { 'build-2': ['paused'] } }))
    mkdirSync(RUN_DIR(h.home), { recursive: true })
    writeFileSync(join(RUN_DIR(h.home), 'files-gate-report.md'), 'REPORT-TEXT-FROM-FILE')
    expect(await carryOut(resumeAt(gateFailure(2)), h.deps)).toBe('released')
    expect(h.handoffs['build-2']).toContain('REPORT-TEXT-FROM-FILE')
    expect(h.changed()).toBe(0)
  })

  it('AC13: with the report file missing, the handoff tells the builder to check its files', async () => {
    const h = withPlan(harness({ acts: { 'build-2': ['paused'] } }))
    await carryOut(resumeAt(gateFailure(2)), h.deps)
    expect(h.handoffs['build-2']).toContain("only the plan's files")
  })

  it('AC13: a run resumed at the tests stage runs the gate again', async () => {
    const h = withPlan(harness({ initial: EXTRA, trees: [{}] }))
    expect(await carryOut(resumeAt(checkpoint('tests', 1)), h.deps)).toBe('review')
    expect(h.calls.filter((c) => c.startsWith('start'))).toEqual([
      'start build-2',
      'start verify-2',
    ])
    expect(h.handoffs['build-2']).toContain('src/extra.ts')
    expect(h.testRuns).toHaveLength(1)
  })

  it('AC14: a failing git command blocks at the tests stage, and Resume runs the gate again', async () => {
    const h = withPlan(harness({ changedFails: [1] }))
    expect(await carryOut(resumeAt(checkpoint('tests', 1)), h.deps)).toBe('released')
    expect(h.testRuns).toHaveLength(0)
    expect(h.of('error').at(-1)).toMatchObject({
      payload: {
        blocks: true,
        cause: 'step_failed',
        stage: 'tests',
        command: 'git -C wt merge-base HEAD origin/main',
      },
    })
    expect(h.runEnd()).toBeUndefined()
    expect(await carryOut(resumeAt(checkpoint('tests', 1)), h.deps)).toBe('review')
    expect(h.testRuns).toHaveLength(1)
  })

  const many = Array.from({ length: 22 }, (_, i) => `p${String(i).padStart(2, '0')}.ts`)
  it('AC15: ends the run on the third refusal, naming up to 20 paths', async () => {
    const h = harness({ trees: [EXTRA, EXTRA, { committed: many }] })
    expect(await carryOut(start, h.deps)).toBe('failed')
    expect(h.calls.filter((c) => c.startsWith('start build'))).toHaveLength(3)
    expect(h.runEnd()).toMatchObject({
      payload: {
        reason: `the build changed files the run does not allow, on attempt 3: ${many.slice(0, 20).join(', ')}, and 2 more`,
      },
    })
  })

  it('AC15: names the paths when attempts 1 and 2 failed at Verify', async () => {
    const h = harness({ trees: [{}, {}, EXTRA], verdicts: ['fail', 'fail'] })
    expect(await carryOut(start, h.deps)).toBe('failed')
    expect(h.runEnd()).toMatchObject({
      payload: {
        reason: 'the build changed files the run does not allow, on attempt 3: src/extra.ts',
      },
    })
  })

  it('AC16: sends a files_gate event with the violations, and an ok one when there are none', async () => {
    const h = harness({ trees: [{ committed: ['src/extra.ts'], uncommitted: ['notes.txt'] }, {}] })
    await carryOut(start, h.deps)
    const gates = h.of('tool_call').filter((e) => e.tool === 'files_gate')
    expect(gates).toHaveLength(2)
    expect(gates[0]).toMatchObject({
      agent: 'runner',
      status: 'error',
      target: '2 paths the run does not allow',
      payload: {
        violations: [
          { path: 'src/extra.ts', reason: 'not in the plan', committed: true },
          { path: 'notes.txt', reason: 'not in the plan', committed: false },
        ],
      },
    })
    expect(gates[1]).toMatchObject({
      status: 'ok',
      target: 'every changed path is allowed',
      payload: { violations: [] },
    })
  })

  it('AC16: words one violation in the singular', async () => {
    const h = harness({ trees: [{ committed: ['src/extra.ts'] }, {}] })
    await carryOut(start, h.deps)
    expect(h.of('tool_call').find((e) => e.tool === 'files_gate')).toMatchObject({
      target: '1 path the run does not allow',
    })
  })

  it('AC19: pushes nothing and fails the run when Verify moved HEAD', async () => {
    const h = harness({ verifyHeads: ['def456'] })
    expect(await carryOut(start, h.deps)).toBe('failed')
    expect(h.writes).toEqual([])
    expect(h.gitCalls).not.toContain(`push ${BRANCH}`)
    expect(h.runEnd()).toMatchObject({
      payload: {
        outcome: 'failed',
        reason: 'Verify changed the branch: HEAD is def456, Build ended on abc123',
      },
    })
  })

  it('AC19: pushes as today when HEAD is where the gate left it', async () => {
    const h = harness({ verifyHeads: ['abc123'] })
    expect(await carryOut(start, h.deps)).toBe('review')
    expect(h.gitCalls).toContain(`push ${BRANCH}`)
  })

  describe('exclusions', () => {
    it('AC6: a file the runner’s test run wrote is excluded on the next attempt', async () => {
      const h = harness({
        trees: [{}, { uncommitted: ['coverage.txt'] }],
        testWrites: [['coverage.txt']],
        verdicts: ['fail', 'pass'],
      })
      expect(await carryOut(start, h.deps)).toBe('review')
      expect(
        JSON.parse(readFileSync(join(RUN_DIR(h.home), 'excluded-paths.json'), 'utf8')),
      ).toEqual(['coverage.txt'])
      expect(h.testRuns).toHaveLength(2)
    })

    it('AC7: before any runner test run, a file the builder’s own test run left is a violation', async () => {
      const h = harness({ trees: [{ uncommitted: ['coverage.txt'] }, {}] })
      expect(await carryOut(start, h.deps)).toBe('review')
      expect(h.handoffs['build-2']).toContain('`coverage.txt` – not in the plan (uncommitted)')
      expect(h.handoffs['build-2']).toContain('delete the file if a command you ran generated it')
    })

    it('records what setup left in the worktree as excluded', async () => {
      const setup = 'npm ci'
      const h = harness({ setupCommand: setup, afterSetup: ['package-lock.json'] })
      const work = {
        kind: 'start',
        run: { ...RUN, project: { ...RUN.project, setup_command: setup } },
      } as Extract<Work, { kind: 'start' }>
      expect(await carryOut(work, h.deps)).toBe('review')
      expect(
        JSON.parse(readFileSync(join(RUN_DIR(h.home), 'excluded-paths.json'), 'utf8')),
      ).toEqual(['package-lock.json'])
    })
  })
})
