import { describe, expect, it } from 'vitest'
import type { Checkpoint, RunWork } from '../../src/contract.js'
import { stateOf } from '../../src/run-steps.js'

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
