import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError, type BoardApi } from '../../src/api.js'
import type { ArtifactView, Checkpoint, RunnerEvent, RunWork, Work } from '../../src/contract.js'
import type { DeliveryDeps, Phases } from '../../src/delivery.js'
import { Git, GitError } from '../../src/git.js'
import type { PhaseRecord, StepResult } from '../../src/phases/phase.js'
import { EventSink } from '../../src/sink.js'
import { LOG_FILE, type LogLine } from '../../src/worktree-log.js'

export const NOW = new Date('2026-11-03T10:00:00.000Z')

export const RUN: RunWork = {
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
export const RUN_DIR = (home: string) => join(home, 'runs', RUN.id)
export const START: Extract<Work, { kind: 'start' }> = { kind: 'start', run: RUN }
export const BRANCH = 'board/PAY-1-r2'

/** What one process of a phase does. */
export type Act = 'ok' | 'paused' | 'cancelled' | 'shutdown' | 'fails' | 'gone'
export type Verdict = 'pass' | 'fail' | 'owner-pass' | 'owner-fail' | 'withdrawn-pass' | 'no-report'
export interface Script {
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
  /** The exit code of each run of the setup command, in turn; 0 when unlisted. */
  setupExits?: number[]
  /** The commit, commit count and paths the fast-forward moves the base by. */
  moveTo?: { head: string; commits?: number; paths?: string[] }
  /** Which refresh step fails with a GitError. */
  fails?: 'fetch' | 'ff' | 'link'
  /** The phase calls throw instead of returning. */
  phaseThrows?: boolean
  /** What the board answers to `run_end`, instead of accepting it. */
  runEndFails?: Error
  /** What `git worktree remove` rejects with. */
  removeFails?: Error
}

export function harness(script: Script) {
  const sent: RunnerEvent[] = []
  const artifacts: ArtifactView[] = []
  const calls: string[] = []
  /** The refresh's git steps and setup runs, with the phase calls, in the order they happened. */
  const order: string[] = []
  let setups = 0
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
      if (script.runEndFails !== undefined && events.some((e) => e.type === 'run_end'))
        throw script.runEndFails
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
                : verdict === 'withdrawn-pass'
                  ? [
                      { id: 'AC1', status: 'pass', evidence: 'e' },
                      { id: 'AC2', status: 'withdrawn', evidence: 'e' },
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
      order.push('phase')
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
      order.push('phase')
      if (script.phaseThrows === true) throw new Error('process did not start')
      calls.push(`resume ${record.phase}-${record.attempt}: ${message}`)
      return act(record)
    },
    restart: async (record) => {
      order.push('phase')
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
    removeWorktree: async (repo: string, dir: string) => {
      gitCalls.push(repo === '/repo' ? 'remove' : `remove linked ${repo}`)
      if (script.removeFails !== undefined) throw script.removeFails
      rmSync(dir, { recursive: true, force: true })
    },
    fetchBase: async () => {
      order.push('fetch')
      if (script.fails === 'fetch') throw new GitError('git fetch origin main', 'no network')
    },
    undoUncommitted: async () => {
      order.push('undo')
      tree.uncommitted = []
    },
    fastForward: async () => {
      order.push('ff')
      if (script.fails === 'ff') throw new GitError('git merge --ff-only origin/main', 'diverged')
      headNow = script.moveTo?.head ?? headNow
    },
    commitCount: async () => script.moveTo?.commits ?? 3,
    changedBetween: async () => script.moveTo?.paths ?? ['a.ts'],
    prepareDetachedWorktree: async (repo: string, base: string, dir: string) => {
      if (script.fails === 'link') throw new GitError(`git -C ${repo} fetch origin ${base}`, 'gone')
      mkdirSync(dir, { recursive: true })
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
      if (command === script.setupCommand) {
        order.push('setup')
        setupRan = true
        tree.uncommitted = [...(script.afterSetup ?? [])]
        return { ...runResult, exitCode: script.setupExits?.[setups++] ?? 0 }
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
    clock: () => NOW,
  }
  return {
    deps,
    sent,
    artifacts,
    calls,
    order,
    gitCalls,
    writes,
    handoffs,
    home,
    testRuns,
    changed: () => changedCalls,
    /** The removal log's lines, oldest first. */
    log: (): LogLine[] => {
      try {
        return readFileSync(join(home, LOG_FILE), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as LogLine)
      } catch {
        return []
      }
    },
    of: (type: string) => sent.filter((e) => e.type === type),
    runEnd: () => sent.find((e) => e.type === 'run_end'),
    checkpoints: () =>
      sent.filter((e) => e.type === 'checkpoint').map((e) => e.payload as unknown as Checkpoint),
  }
}

export const checkpoint = (
  stage: Checkpoint['stage'],
  attempt: number,
  phase?: string,
): Checkpoint => ({
  stage,
  attempt,
  phase_id: phase ?? null,
  session: phase === undefined ? null : { id: 's-1', baseline: {}, reported: {} },
  head: 'abc123',
  plan_artifact_id: 'plan-1',
  failing_report_id: null,
})
export const resume = (
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
export function withPlan(h: ReturnType<typeof harness>) {
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
