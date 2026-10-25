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
      interrupted: false,
      at: new Date(TS),
    })
  })

  it('reads a phase end whose process was stopped', () => {
    expect(effectOf(event('phase_end', { status: 'succeeded', interrupted: true }))).toMatchObject({
      kind: 'phase_end',
      interrupted: true,
    })
  })

  it('reads a resumed phase start as the same phase running again', () => {
    expect(
      effectOf(
        event('phase_start', { name: 'build', attempt: 1, session_id: 's2', resumed: true }),
      ),
    ).toEqual({
      kind: 'phase_resume',
      phaseId: '00000000-0000-4000-8000-000000000003',
      sessionId: 's2',
      at: new Date(TS),
    })
  })

  const CHECKPOINT = {
    stage: 'build',
    attempt: 2,
    phase_id: '00000000-0000-4000-8000-000000000003',
    session: {
      id: 's',
      baseline: {
        'claude-sonnet-x': { input: 1, output: 2, cache_read: 3, cache_write: 4, usd: 0.01 },
      },
      reported: { 'claude-sonnet-x': 0.01 },
    },
    head: 'abc123',
    plan_artifact_id: '00000000-0000-4000-8000-000000000009',
    failing_report_id: null,
  }

  it('reads a checkpoint', () => {
    expect(effectOf(event('checkpoint', CHECKPOINT, { phase_id: null }))).toEqual({
      kind: 'checkpoint',
      checkpoint: CHECKPOINT,
    })
  })

  it('reads a checkpoint between phases, with no session', () => {
    const between = { ...CHECKPOINT, stage: 'tests', phase_id: null, session: null }
    expect(effectOf(event('checkpoint', between, { phase_id: null }))).toEqual({
      kind: 'checkpoint',
      checkpoint: between,
    })
  })

  it.each([
    [
      'a failed step',
      { blocks: true, cause: 'step_failed', stage: 'push', command: 'git push', output: 'denied' },
      { cause: 'step_failed', stage: 'push', command: 'git push', output: 'denied' },
    ],
    [
      'a stopped runner',
      { blocks: true, cause: 'runner_stopped', stage: 'verify' },
      { cause: 'runner_stopped', stage: 'verify' },
    ],
  ])('reads a block for %s', (_name, payload, block) => {
    expect(effectOf(event('error', payload, { phase_id: null }))).toEqual({
      kind: 'block',
      block,
    })
  })

  it('keeps only the end of a long step output', () => {
    const output = `${'x'.repeat(10_000)}the end`
    const effect = effectOf(
      event('error', { blocks: true, cause: 'step_failed', stage: 'pr', command: 'gh', output }),
    )
    expect(effect).toMatchObject({ kind: 'block' })
    const kept = (effect as { block: { output: string } }).block.output
    expect(kept).toHaveLength(8_000)
    expect(kept.endsWith('the end')).toBe(true)
  })

  it('reads the plan gate’s approval request', () => {
    expect(
      effectOf(
        event('approval_requested', {
          approval_id: '00000000-0000-4000-8000-00000000000a',
          kind: 'plan',
          question: 'Approve this plan?',
          context_md: '1. Do it',
        }),
      ),
    ).toEqual({
      kind: 'plan_approval',
      approvalId: '00000000-0000-4000-8000-00000000000a',
      phaseId: '00000000-0000-4000-8000-000000000003',
      question: 'Approve this plan?',
      contextMd: '1. Do it',
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

  // Slice 3: a spec run's stage, and its end with a drafted spec.
  it('reads a checkpoint in a spec run’s Spec stage', () => {
    const drafting = { ...CHECKPOINT, stage: 'spec', plan_artifact_id: null }
    expect(effectOf(event('checkpoint', drafting, { phase_id: null }))).toEqual({
      kind: 'checkpoint',
      checkpoint: drafting,
    })
  })

  it('reads a spec run’s end with its draft', () => {
    expect(
      effectOf(event('run_end', { outcome: 'drafted', worktree_path: '/w' }, { phase_id: null })),
    ).toEqual({
      kind: 'run_end',
      outcome: 'drafted',
      reason: null,
      prNumber: null,
      prUrl: null,
      branch: null,
      worktreePath: '/w',
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
    ['a checkpoint at an unknown stage', event('checkpoint', { ...CHECKPOINT, stage: 'deploy' })],
    ['a checkpoint at attempt zero', event('checkpoint', { ...CHECKPOINT, attempt: 0 })],
    [
      'a checkpoint whose session is not an object',
      event('checkpoint', { ...CHECKPOINT, session: 'x' }),
    ],
    [
      'a checkpoint whose baseline is not usage',
      event('checkpoint', {
        ...CHECKPOINT,
        session: { ...CHECKPOINT.session, baseline: { m: { input: 'x' } } },
      }),
    ],
    [
      'a block the runner may not raise: a lost runner',
      event('error', { blocks: true, cause: 'runner_lost', stage: null }),
    ],
    [
      'a block the runner may not raise: an expired question',
      event('error', { blocks: true, cause: 'approval_expired', stage: null }),
    ],
    [
      'a failed step with no command',
      event('error', { blocks: true, cause: 'step_failed', stage: 'push' }),
    ],
    [
      'a plan approval with no id',
      event('approval_requested', { kind: 'plan', question: 'Approve?' }),
    ],
    [
      'a question from the runner rather than an agent',
      event('approval_requested', {
        approval_id: '00000000-0000-4000-8000-00000000000a',
        kind: 'question',
        question: 'Which?',
      }),
    ],
    [
      'a plan approval outside a phase',
      event(
        'approval_requested',
        { approval_id: '00000000-0000-4000-8000-00000000000a', kind: 'plan', question: 'Approve?' },
        { phase_id: null },
      ),
    ],
  ])('refuses %s', (_name, input) => {
    expect(() => effectOf(input)).toThrow(/payload/)
  })
})
