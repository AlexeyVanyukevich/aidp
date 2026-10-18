export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

/** USD per million tokens, in effect from `effectiveFrom` (a UTC date) until a later row. */
export interface PriceRow {
  model: string
  effectiveFrom: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export function priceAt(rows: PriceRow[], model: string, at: Date): PriceRow | undefined {
  const day = at.toISOString().slice(0, 10)
  let best: PriceRow | undefined
  for (const row of rows) {
    if (row.model !== model || row.effectiveFrom > day) continue
    if (best === undefined || row.effectiveFrom > best.effectiveFrom) best = row
  }
  return best
}

export function costOf(usage: Usage, price: PriceRow): number {
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * price.cacheWrite) /
    1_000_000
  )
}
