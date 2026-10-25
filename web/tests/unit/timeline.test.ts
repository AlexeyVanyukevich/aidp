import { describe, expect, it } from 'vitest'
import { runLabel, stepLabel, timelineModel } from '../../src/card/timeline'
import type { EventView, PhaseView } from '../../src/types'

const phase = (id: string, name: string, attempt: number, started: string): PhaseView => ({
  id,
  name,
  attempt,
  agent: 'a',
  model: 'm',
  status: 'succeeded',
  summary_md: null,
  started_at: started,
  ended_at: null,
  interrupted: false,
})
const event = (id: string, phaseId: string | null, ts: string, input = 0): EventView => ({
  id,
  phase_id: phaseId,
  ts,
  type: input > 0 ? 'message' : 'tool_call',
  agent: 'a',
  model: null,
  tool: null,
  target: null,
  status: null,
  duration_ms: null,
  usage: { input, output: 0, cache_read: 0, cache_write: 0 },
  payload: {},
})

// Slice 3: drafts and delivery runs are numbered apart.
describe('runLabel', () => {
  it.each([
    [{ kind: 'spec', number: 2 }, 'Draft 2'],
    [{ kind: 'delivery', number: 1 }, 'Run 1'],
  ])('names %j "%s"', (run, label) => {
    expect(runLabel(run)).toBe(label)
  })
})

describe('timelineModel', () => {
  it('puts each event in its phase’s band, phases and steps in time order', () => {
    const phases = [
      phase('b1', 'build', 1, '2026-10-11T10:01:00Z'),
      phase('p1', 'plan', 1, '2026-10-11T10:00:00Z'),
    ]
    const events = [
      event('e2', 'p1', '2026-10-11T10:00:20Z', 100),
      event('e1', 'p1', '2026-10-11T10:00:10Z'),
      event('e3', 'b1', '2026-10-11T10:01:10Z', 50),
      event('t', null, '2026-10-11T10:02:00Z'),
    ]
    const model = timelineModel(phases, events)
    expect(model.bands.map((b) => [b.phase.id, b.steps.map((s) => s.id), b.tokens])).toEqual([
      ['p1', ['e1', 'e2'], 100],
      ['b1', ['e3'], 50],
    ])
    expect(model.loose.map((e) => e.id)).toEqual(['t'])
  })

  // From the phase's last step before it stopped — the question — to its resumed start.
  it('marks a pause in its phase’s band, as long as the phase waited', () => {
    const phases = [phase('b1', 'build', 1, '2026-10-11T10:00:00Z')]
    const at = (id: string, ts: string, type: string, payload: Record<string, unknown> = {}) => ({
      ...event(id, 'b1', ts),
      type,
      payload,
    })
    const events = [
      at('s', '2026-10-11T10:00:00Z', 'phase_start'),
      at('q', '2026-10-11T10:01:00Z', 'approval_requested', { question: 'How many?' }),
      at('a', '2026-10-11T11:31:00Z', 'approval_answered'),
      at('r', '2026-10-11T11:31:05Z', 'phase_start', { resumed: true }),
    ]
    const [band] = timelineModel(phases, events).bands
    expect(band!.entries.map((e) => ('kind' in e ? `paused ${e.ms}` : e.id))).toEqual([
      's',
      'q',
      'a',
      'paused 5405000',
      'r',
    ])
  })

  it('leaves a band with no pause as it was', () => {
    const [band] = timelineModel(
      [phase('p1', 'plan', 1, '2026-10-11T10:00:00Z')],
      [event('e1', 'p1', '2026-10-11T10:00:10Z')],
    ).bands
    expect(band!.entries.map((e) => ('kind' in e ? 'paused' : e.id))).toEqual(['e1'])
  })
})

describe('stepLabel', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['approval_requested', { question: 'How many retries?' }, 'Asked: How many retries?'],
    ['approval_answered', {}, 'Answered'],
    ['phase_start', { resumed: true }, 'Resumed'],
  ])('words a %s step', (type, payload, label) => {
    expect(stepLabel({ ...event('x', 'p', '2026-10-11T10:00:00Z'), type, payload })).toBe(label)
  })
})
