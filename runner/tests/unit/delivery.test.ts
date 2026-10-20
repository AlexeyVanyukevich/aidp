import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BoardApi } from '../../src/api.js'
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
  },
}
const START: Work = { kind: 'start', run: RUN }
const BRANCH = 'board/PAY-1-r2'

/** What one process of a phase does. */
type Act = 'ok' | 'paused' | 'cancelled' | 'shutdown' | 'fails' | 'gone'
type Verdict = 'pass' | 'fail' | 'no-report'
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
}

function harness(script: Script) {
  const sent: RunnerEvent[] = []
  const artifacts: ArtifactView[] = []
  const calls: string[] = []
  const gitCalls: string[] = []
  const used: Record<string, number> = {}
  let plans = 0
  let verifies = 0
  let builds = 0
  let pushes = 0

  const api = {
    issueToken: async () => 'token',
    retire: async () => undefined,
    sendEvents: async (_t: string, events: RunnerEvent[]) => {
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
    if (what === 'ok' && record.phase === 'build') builds += 1
    if (what === 'ok' && record.phase === 'verify') {
      const verdict = script.verdicts?.[verifies++] ?? 'pass'
      if (verdict !== 'no-report')
        artifacts.push({
          id: `report-${verifies}`,
          kind: 'verify_report',
          phase_id: record.phaseId,
          body_md: `| AC1 | ${verdict} |`,
          uri: null,
          data: { summary: 's', criteria: [{ id: 'AC1', status: verdict, evidence: 'e' }] },
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
    head: async () => 'abc123',
    currentBranch: async () => BRANCH,
    deleteBranch: async () => {
      gitCalls.push('delete branch')
    },
    push: async (_d: string, branch: string) => {
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
    createPr: async () => {
      gitCalls.push('create pr')
      return { number: 9, url: 'https://github.com/owner/pay/pull/9' }
    },
    removeWorktree: async () => {
      gitCalls.push('remove')
    },
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
    runTests: async () => ({
      exitCode: 0,
      timedOut: false,
      output: 'tests ok',
      truncated: false,
      durationMs: 5,
    }),
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
    handoffs,
    home,
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
