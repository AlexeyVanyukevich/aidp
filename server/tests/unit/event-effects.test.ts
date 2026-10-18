import { describe, expect, it } from 'vitest'
import { effectOf } from '../../src/modules/runner/event-effects.js'
import type { RunnerEvent } from '../../src/modules/runner/runner.schemas.js'

const TS = '2026-10-11T10:00:00.000Z'
function event(
  type: RunnerEvent['type'],
  payload: Record<string, unknown>,
  extra: Partial<RunnerEvent> = {},
): RunnerEvent {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    run_id: '00000000-0000-4000-8000-000000000002',
    phase_id: '00000000-0000-4000-8000-000000000003',
    ts: TS,
    type,
    agent: 'planner',
    model: 'claude-sonnet-x',
    tool: null,
    target: null,
    status: null,
    duration_ms: null,
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    payload,
    ...extra,
  }
}

describe('effectOf', () => {
  it('reads a phase start', () => {
    expect(effectOf(event('phase_start', { name: 'plan', attempt: 1, session_id: 's' }))).toEqual({
      kind: 'phase_start',
      phaseId: '00000000-0000-4000-8000-000000000003',
      name: 'plan',
      attempt: 1,
      agent: 'planner',
      model: 'claude-sonnet-x',
      sessionId: 's',
      at: new Date(TS),
    })
  })

  it('reads a phase end with the cost Claude Code reported', () => {
    expect(
      effectOf(
        event('phase_end', { status: 'succeeded', summary_md: 'Done', reported_cost: { m: 0.5 } }),
      ),
    ).toEqual({
      kind: 'phase_end',
      phaseId: '00000000-0000-4000-8000-000000000003',
      status: 'succeeded',
      summary: 'Done',
      reportedCost: { m: 0.5 },
      sessionId: null,
      at: new Date(TS),
    })
  })

  it('reads a run end with its pull request', () => {
    expect(
      effectOf(
        event(
          'run_end',
          {
            outcome: 'review',
            pr_number: 7,
            pr_url: 'https://github.com/o/r/pull/7',
            branch: 'board/PAY-1-r1',
          },
          { phase_id: null },
        ),
      ),
    ).toEqual({
      kind: 'run_end',
      outcome: 'review',
      reason: null,
      prNumber: 7,
      prUrl: 'https://github.com/o/r/pull/7',
      branch: 'board/PAY-1-r1',
      worktreePath: null,
      at: new Date(TS),
    })
  })

  it.each(['message', 'tool_call', 'subagent_start', 'error'] as const)(
    'has no effect for %s',
    (type) => {
      expect(effectOf(event(type, {}))).toBeUndefined()
    },
  )

  it.each([
    [
      'a phase start with no phase id',
      event('phase_start', { name: 'plan', attempt: 1 }, { phase_id: null }),
    ],
    ['a phase start for an unknown phase', event('phase_start', { name: 'deploy', attempt: 1 })],
    ['a phase start with attempt zero', event('phase_start', { name: 'plan', attempt: 0 })],
    [
      'a phase start with no agent',
      event('phase_start', { name: 'plan', attempt: 1 }, { agent: null }),
    ],
    ['a phase end with an unknown status', event('phase_end', { status: 'paused' })],
    [
      'a phase end whose cost is not a number',
      event('phase_end', { status: 'failed', reported_cost: { m: 'x' } }),
    ],
    ['a run end with an unknown outcome', event('run_end', { outcome: 'merged' })],
    ['a review without a pull request', event('run_end', { outcome: 'review' })],
  ])('refuses %s', (_name, input) => {
    expect(() => effectOf(input)).toThrow(/payload/)
  })
})
