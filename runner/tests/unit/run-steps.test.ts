import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
    const steps = runSteps({ kind: 'start', run: RUN }, deps, { worktree, runDir, budgetUsd: null })
    const outcome = await steps.carry({ repo: '/repo', branch: null }, how as never)
    return { outcome, removed, worktree, path, linked }
  }

  it.each<[string, () => Promise<{ outcome: string; extra: Record<string, unknown> }>, string]>([
    ['succeeds', async () => ({ outcome: 'review', extra: {} }), 'review'],
    ['fails', async () => Promise.reject(new End('failed', 'x')), 'failed'],
    ['is cancelled', async () => Promise.reject(new End('cancelled', 'x')), 'cancelled'],
  ])('removes the checkout and its directory when the run %s', async (_name, how, outcome) => {
    const result = await ended(how)
    expect(result.outcome).toBe(outcome)
    expect(result.removed).toContain(`/zlc ${result.path}`)
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
