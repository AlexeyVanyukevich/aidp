import { describe, expect, it } from 'vitest'
import { timelineModel } from '../../src/card/timeline'
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
})
