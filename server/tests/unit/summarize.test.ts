import { describe, expect, it } from 'vitest'
import {
  summarizeCosts,
  type CostEvent,
  type CostPhase,
} from '../../src/modules/costs/summarize.js'
import type { PriceRow } from '../../src/modules/costs/pricing.js'

const PRICES: PriceRow[] = [
  {
    model: 'big',
    effectiveFrom: '2026-01-01',
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 20,
  },
  {
    model: 'small',
    effectiveFrom: '2026-01-01',
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 2,
  },
]
const TS = new Date('2026-10-11T10:00:00Z')
const usage = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
})

const PHASES: CostPhase[] = [
  { id: 'p1', name: 'plan', attempt: 1, reportedCost: { big: 10 } },
  { id: 'p2', name: 'build', attempt: 1, reportedCost: { big: 5, small: 1 } },
]
const EVENTS: CostEvent[] = [
  { phaseId: 'p1', agent: 'planner', model: 'big', ts: TS, usage: usage(1e6) }, // $10
  { phaseId: 'p2', agent: 'builder', model: 'big', ts: TS, usage: usage(0, 100_000) }, // $5
  { phaseId: 'p2', agent: 'explorer', model: 'small', ts: TS, usage: usage(0, 0, 1e6) }, // $0.1
  { phaseId: 'p2', agent: 'claude-code', model: 'small', ts: TS, usage: usage(900_000) }, // $0.9
  { phaseId: 'p2', agent: 'runner', model: null, ts: TS, usage: usage(0) }, // a tool call
]

describe('summarizeCosts', () => {
  const summary = summarizeCosts({ events: EVENTS, phases: PHASES, prices: PRICES })

  it('totals every counter and the dollars', () => {
    expect(summary.totals.usage).toEqual(usage(1_900_000, 100_000, 1_000_000, 0))
    expect(summary.totals.usd).toBeCloseTo(16, 10)
  })

  it('splits by phase and compares each with what Claude Code reported', () => {
    expect(summary.byPhase).toEqual([
      expect.objectContaining({
        phaseId: 'p1',
        usd: 10,
        reportedUsd: 10,
        drift: 0,
        flagged: false,
      }),
      expect.objectContaining({ phaseId: 'p2', reportedUsd: 6, flagged: false }),
    ])
    // 5 + 0.1 + 0.9 in floating point: equal to 6 to ten places, not exactly.
    expect(summary.byPhase[1]?.usd).toBeCloseTo(6, 10)
    expect(summary.byPhase[1]?.drift).toBeCloseTo(0, 10)
  })

  it('splits by agent and by model, largest first', () => {
    expect(summary.byAgent.map((line) => line.agent)).toEqual([
      'planner',
      'builder',
      'claude-code',
      'explorer',
    ])
    expect(summary.byModel.map((line) => line.model)).toEqual(['big', 'small'])
  })

  it('reports the cache hit ratio as cache reads over all input', () => {
    expect(summary.cacheHitRatio).toBeCloseTo(1_000_000 / 2_900_000, 10)
  })

  it.each([
    ['just under the limit', 10 * 1.019, false],
    ['just over the limit', 10 * 1.021, true],
    ['under by more than the limit', 10 * 0.97, true],
  ])('flags a phase whose drift is %s', (_name, reported, flagged) => {
    const result = summarizeCosts({
      events: [EVENTS[0]!],
      phases: [{ ...PHASES[0]!, reportedCost: { big: reported } }],
      prices: PRICES,
    })
    expect(result.byPhase[0]?.flagged).toBe(flagged)
  })

  it('names a model with no price and leaves its phase uncompared', () => {
    const result = summarizeCosts({
      events: [{ ...EVENTS[0]!, model: 'new-model' }],
      phases: [PHASES[0]!],
      prices: PRICES,
    })
    expect(result.missingPrices).toEqual(['new-model'])
    expect(result.byPhase[0]).toMatchObject({ usd: 0, drift: null, flagged: false })
  })

  it('has no ratio and no phases for an empty run', () => {
    const result = summarizeCosts({ events: [], phases: [], prices: PRICES })
    expect(result.cacheHitRatio).toBeNull()
    expect(result.totals.usd).toBe(0)
  })
})
