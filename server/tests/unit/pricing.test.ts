import { describe, expect, it } from 'vitest'
import { costOf, priceAt, type PriceRow } from '../../src/modules/costs/pricing.js'

const ROWS: PriceRow[] = [
  { model: 'm', effectiveFrom: '2026-01-01', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 },
  { model: 'm', effectiveFrom: '2026-06-01', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
  { model: 'other', effectiveFrom: '2026-01-01', input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
]

describe('priceAt', () => {
  it.each([
    ['before any row', '2025-12-31T23:59:59Z', undefined],
    ['on the first row’s day', '2026-01-01T00:00:00Z', '2026-01-01'],
    ['between rows', '2026-05-31T23:59:59Z', '2026-01-01'],
    ['on the second row’s day', '2026-06-01T00:00:00Z', '2026-06-01'],
    ['long after', '2027-01-01T00:00:00Z', '2026-06-01'],
  ])('%s', (_name, at, effectiveFrom) => {
    expect(priceAt(ROWS, 'm', new Date(at))?.effectiveFrom).toBe(effectiveFrom)
  })

  it('knows nothing of a model with no row', () => {
    expect(priceAt(ROWS, 'unknown', new Date('2026-07-01'))).toBeUndefined()
  })
})

describe('costOf', () => {
  const price = ROWS[0]!
  it.each([
    ['a million input tokens', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, 1],
    ['a million output tokens', { input: 0, output: 1e6, cacheRead: 0, cacheWrite: 0 }, 5],
    ['a million cache reads', { input: 0, output: 0, cacheRead: 1e6, cacheWrite: 0 }, 0.1],
    ['a million cache writes', { input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6 }, 2],
    [
      'all four at once',
      { input: 500_000, output: 200_000, cacheRead: 1e6, cacheWrite: 250_000 },
      0.5 + 1 + 0.1 + 0.5,
    ],
    ['nothing', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 0],
  ])('%s', (_name, usage, usd) => {
    expect(costOf(usage, price)).toBeCloseTo(usd, 10)
  })
})
