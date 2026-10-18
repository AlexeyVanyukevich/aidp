import { describe, expect, it } from 'vitest'
import { formatDuration, formatPercent, formatTokens } from '../../src/card/format'

describe('format', () => {
  it.each([
    [0, '0'],
    [950, '950'],
    [12_345, '12.3k'],
    [2_500_000, '2.5M'],
  ])('formatTokens(%s) → %s', (n, text) => {
    expect(formatTokens(n)).toBe(text)
  })
  it.each([
    [400, '0.4 s'],
    [65_000, '1 min 5 s'],
    [3_600_000, '60 min 0 s'],
  ])('formatDuration(%s) → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })
  it.each([
    [null, '—'],
    [0.4567, '45.7%'],
  ])('formatPercent(%s) → %s', (ratio, text) => {
    expect(formatPercent(ratio)).toBe(text)
  })
})
