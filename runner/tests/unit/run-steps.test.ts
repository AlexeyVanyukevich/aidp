import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Checkpoint, RunWork } from '../../src/contract.js'
import type { Git } from '../../src/git.js'
import {
  baseMovedNote,
  End,
  Release,
  runPaths,
  runSteps,
  stateOf,
  type RunDeps,
} from '../../src/run-steps.js'

const RUN = { id: 'run-1' } as RunWork
const at = (stage: Checkpoint['stage'], session: Checkpoint['session']): Checkpoint => ({
  stage,
  attempt: 1,
  phase_id: session === null ? null : 'phase-1',
  session,
  head: null,
  plan_artifact_id: null,
  failing_report_id: null,
})
const SESSION = { id: 'session-1', baseline: {}, reported: {} }

// Where a resume starts: a phase stage with its session continues that phase; any other stage
// reruns its step (slice 2 spec, §6), a spec run's Spec stage among the phases (slice 3, §5).
describe('stateOf', () => {
  it.each<[string, Checkpoint, string | null]>([
    ['a spec run in its Spec phase', at('spec', SESSION), 'spec'],
    ['a delivery run in Build', at('build', SESSION), 'build'],
    ['a spec run preparing its worktree', at('prepare', null), null],
    ['a delivery run between its tests', at('tests', null), null],
  ])('resumes %s', (_name, checkpoint, phase) => {
    const state = stateOf({
      kind: 'resume',
      run: RUN,
      checkpoint,
      message: 'answers',
      allowed_files: [],
    })
    expect(state.phase?.phase ?? null).toBe(phase)
    expect(state.stage).toBe(checkpoint.stage)
    expect(state.message).toBe('answers')
  })
})

// A run's linked checkouts go with its worktree when it ends, and stay when it is released.
describe('carry and the linked checkouts', () => {
  async function ended(how: () => Promise<{ outcome: string; extra: Record<string, unknown> }>) {
    const home = mkdtempSync(join(tmpdir(), 'home-'))
    const { worktree, runDir, linked } = runPaths(home, RUN.id)
    const path = join(linked, 'ZLC')
    mkdirSync(path, { recursive: true })
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, 'linked.json'),
      JSON.stringify([{ key: 'ZLC', repo_path: '/zlc', path }]),
    )
    const removed: string[] = []
    const deps = {
      api: { issueToken: async () => 't' },
      git: {
        removeWorktree: async (repo: string, dir: string) => {
          removed.push(`${repo} ${dir}`)
        },
        pruneWorktrees: async () => undefined,
      } as unknown as Git,
      sink: { send: async () => undefined },
      setToken: () => undefined,
      config: { home },
    } as unknown as RunDeps
    const realPath = realpathSync(path)
    const steps = runSteps({ kind: 'start', run: RUN }, deps, { worktree, runDir, budgetUsd: null })
    const outcome = await steps.carry({ repo: '/repo', branch: null }, how as never)
    return { outcome, removed, worktree, path, realPath, linked }
  }

  it.each<[string, () => Promise<{ outcome: string; extra: Record<string, unknown> }>, string]>([
    ['succeeds', async () => ({ outcome: 'review', extra: {} }), 'review'],
    ['fails', async () => Promise.reject(new End('failed', 'x')), 'failed'],
    ['is cancelled', async () => Promise.reject(new End('cancelled', 'x')), 'cancelled'],
  ])('removes the checkout and its directory when the run %s', async (_name, how, outcome) => {
    const result = await ended(how)
    expect(result.outcome).toBe(outcome)
    expect(result.removed).toContain(`/zlc ${result.realPath}`)
    expect(existsSync(result.linked)).toBe(false)
  })

  it('keeps the checkout when the run is released', async () => {
    const result = await ended(async () => Promise.reject(new Release()))
    expect(result.outcome).toBe('released')
    expect(result.removed).toEqual([])
    expect(existsSync(result.path)).toBe(true)
  })
})

const MANY = Array.from({ length: 103 }, (_, i) => `p${String(i).padStart(3, '0')}.ts`)
const PLAN_LAST =
  'Check your plan against these changes, and save a revised plan with save_plan if the plan changes.'
const SPEC_LAST =
  'Check your questions and your draft against these changes, and save the spec again with save_spec if it changes.'

interface NoteRow {
  name: string
  phase: 'plan' | 'spec'
  commits: number
  paths: string[]
  expected: string
}
const NOTE_ROWS: NoteRow[] = [
  {
    name: 'plan, one commit',
    phase: 'plan',
    commits: 1,
    paths: ['x.ts'],
    expected: [
      'The base branch moved while the run was paused. You last read the code at aaa; it is now at bbb, 1 commit later.',
      'Paths changed between them:',
      'x.ts',
      PLAN_LAST,
    ].join('\n'),
  },
  {
    name: 'spec, three commits',
    phase: 'spec',
    commits: 3,
    paths: ['a.ts', 'b.ts'],
    expected: [
      'The base branch moved while the run was paused. You last read the code at aaa; it is now at bbb, 3 commits later.',
      'Paths changed between them:',
      'a.ts',
      'b.ts',
      SPEC_LAST,
    ].join('\n'),
  },
  {
    name: 'plan, lists the first 100 paths then how many more',
    phase: 'plan',
    commits: 3,
    paths: MANY,
    expected: [
      'The base branch moved while the run was paused. You last read the code at aaa; it is now at bbb, 3 commits later.',
      'Paths changed between them:',
      ...MANY.slice(0, 100),
      'and 3 more',
      PLAN_LAST,
    ].join('\n'),
  },
  {
    name: 'spec, lists the first 100 paths then how many more',
    phase: 'spec',
    commits: 3,
    paths: MANY,
    expected: [
      'The base branch moved while the run was paused. You last read the code at aaa; it is now at bbb, 3 commits later.',
      'Paths changed between them:',
      ...MANY.slice(0, 100),
      'and 3 more',
      SPEC_LAST,
    ].join('\n'),
  },
]

describe('baseMovedNote', () => {
  it.each(NOTE_ROWS)('AC9: $name', ({ phase, commits, paths, expected }) => {
    expect(baseMovedNote(phase, { from: 'aaa', to: 'bbb', commits, paths })).toBe(expected)
  })
})

// R1, R3: setup records the merge-base it ran on; the tests stage undoes what the builder left.
describe('setup bookkeeping', () => {
  const MERGE_BASE = 'm'.repeat(40)
  const setupFile = (runDir: string) => join(runDir, 'setup-base.txt')

  function rig(o: { setupExit?: number; uncommitted?: string[]; excluded?: string[] } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'home-'))
    const { worktree, runDir } = runPaths(home, RUN.id)
    mkdirSync(runDir, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    if (o.excluded !== undefined)
      writeFileSync(join(runDir, 'excluded-paths.json'), JSON.stringify(o.excluded))
    const events: { tool: string | null; target: string | null; payload: unknown }[] = []
    const undone: number[] = []
    const deps = {
      api: { issueToken: async () => 't' },
      git: {
        mergeBase: async () => MERGE_BASE,
        fetchBase: async () => undefined,
        head: async () => 'h',
        undoUncommitted: async () => {
          undone.push(1)
        },
        fastForward: async () => undefined,
        changedPaths: async () => ({
          mergeBase: MERGE_BASE,
          committed: [],
          uncommitted: o.uncommitted ?? [],
        }),
        branchExists: async () => true,
        prepareDetachedWorktree: async () => undefined,
        removeWorktree: async () => undefined,
        pruneWorktrees: async () => undefined,
      } as unknown as Git,
      sink: {
        send: async (batch: { tool: string | null; target: string | null; payload: unknown }[]) => {
          events.push(...batch)
        },
      },
      runTests: async () => ({
        exitCode: o.setupExit ?? 0,
        timedOut: false,
        output: '',
        truncated: false,
        durationMs: 1,
      }),
      setToken: () => undefined,
      config: { home, testTimeoutMs: 1000 },
    } as unknown as RunDeps
    const steps = runSteps({ kind: 'start', run: RUN }, deps, { worktree, runDir, budgetUsd: null })
    return { steps, runDir, events, undone }
  }

  type Point = 'prepare' | 'refresh' | 'recreate' | 'tests'
  const POINTS: Point[] = ['prepare', 'refresh', 'recreate', 'tests']
  const runPoint = (r: ReturnType<typeof rig>, point: Point) => {
    if (point === 'refresh') return r.steps.refreshBase('plan', '/repo', 'main', 'npm ci')
    if (point === 'recreate')
      return r.steps.recreate({
        caller: 'delivery_resume',
        repo: '/repo',
        branch: null,
        add: async () => undefined,
        setup: { command: 'npm ci', after: async () => undefined, base: 'main' },
      })
    // `prepare` and the tests stage both call runSetup with the base.
    return r.steps.runSetup('npm ci', undefined, 'main')
  }

  it.each(POINTS)('AC1: %s writes the merge-base when setup succeeds', async (point) => {
    const r = rig()
    await runPoint(r, point)
    expect(readFileSync(setupFile(r.runDir), 'utf8')).toBe(MERGE_BASE)
  })

  it.each(POINTS)('AC1: %s leaves the file as it was when setup fails', async (point) => {
    const r = rig({ setupExit: 1 })
    writeFileSync(setupFile(r.runDir), 'old')
    await expect(runPoint(r, point)).rejects.toBeInstanceOf(Release)
    expect(readFileSync(setupFile(r.runDir), 'utf8')).toBe('old')
  })

  it('writes nothing when the project has no setup command', async () => {
    const r = rig()
    await r.steps.runSetup(null, undefined, 'main')
    expect(existsSync(setupFile(r.runDir))).toBe(false)
  })

  it.each<[string, string | null, string | null, boolean]>([
    ['equal to the merge-base', 'npm ci', MERGE_BASE, false],
    ['different from it', 'npm ci', 'other', true],
    ['missing', 'npm ci', null, true],
    ['missing, without a setup command', null, null, false],
  ])('R1: setup owed when the file is %s', async (_name, command, file, owed) => {
    const r = rig()
    if (file !== null) writeFileSync(setupFile(r.runDir), file)
    expect(await r.steps.setupOwed(command, 'main')).toBe(owed)
  })

  it.each<[string, string[], string[] | undefined, string[] | null]>([
    ['the builder’s paths only', ['a.ts', 'lock.json'], ['lock.json'], ['a.ts']],
    ['paths sorted', ['b.ts', 'a.ts'], [], ['a.ts', 'b.ts']],
    ['only the runner’s paths: no event', ['lock.json'], ['lock.json'], null],
    ['nothing uncommitted: no event', [], undefined, null],
  ])('AC7: undo_uncommitted names %s', async (_name, uncommitted, excluded, named) => {
    const r = rig({ uncommitted, ...(excluded === undefined ? {} : { excluded }) })
    await r.steps.undoUncommitted('main')
    expect(r.undone).toHaveLength(1)
    const sent = r.events.filter((e) => e.tool === 'undo_uncommitted')
    if (named === null) expect(sent).toEqual([])
    else {
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({
        target: `undid ${named.length} paths the build left uncommitted`,
        status: 'ok',
        agent: 'runner',
        payload: { paths: named },
      })
    }
  })
})
