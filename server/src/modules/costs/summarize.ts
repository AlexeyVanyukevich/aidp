import { addUsage, costOf, priceAt, ZERO_USAGE, type PriceRow, type Usage } from './pricing.js'

/** Above this, a phase's computed cost and Claude Code's own disagree enough to say so. */
export const DRIFT_LIMIT = 0.02

export interface CostEvent {
  phaseId: string | null
  agent: string | null
  model: string | null
  ts: Date
  usage: Usage
}

export interface CostPhase {
  id: string
  name: string
  attempt: number
  reportedCost: Record<string, number> | null
}

export interface Line {
  usage: Usage
  usd: number
}

export type PhaseLine = Line & {
  phaseId: string
  name: string
  attempt: number
  reportedUsd: number | null
  drift: number | null
  flagged: boolean
}

export interface CostSummary {
  totals: Line
  byPhase: PhaseLine[]
  byAgent: (Line & { agent: string })[]
  byModel: (Line & { model: string })[]
  cacheHitRatio: number | null
  missingPrices: string[]
}

function accumulate(map: Map<string, Line>, key: string, usage: Usage, usd: number): void {
  const line = map.get(key) ?? { usage: ZERO_USAGE, usd: 0 }
  map.set(key, { usage: addUsage(line.usage, usage), usd: line.usd + usd })
}

const byUsd = <T extends Line>(a: T, b: T) => b.usd - a.usd

export function summarizeCosts(input: {
  events: CostEvent[]
  phases: CostPhase[]
  prices: PriceRow[]
}): CostSummary {
  const missing = new Set<string>()
  const unpricedPhases = new Set<string>()
  const phases = new Map<string, Line>()
  const agents = new Map<string, Line>()
  const models = new Map<string, Line>()
  let totals: Line = { usage: ZERO_USAGE, usd: 0 }

  for (const event of input.events) {
    if (event.model === null) continue
    const price = priceAt(input.prices, event.model, event.ts)
    if (price === undefined) {
      missing.add(event.model)
      if (event.phaseId !== null) unpricedPhases.add(event.phaseId)
    }
    const usd = price === undefined ? 0 : costOf(event.usage, price)
    totals = { usage: addUsage(totals.usage, event.usage), usd: totals.usd + usd }
    if (event.phaseId !== null) accumulate(phases, event.phaseId, event.usage, usd)
    accumulate(agents, event.agent ?? 'unknown', event.usage, usd)
    accumulate(models, event.model, event.usage, usd)
  }

  const byPhase: PhaseLine[] = input.phases.map((phase) => {
    const line = phases.get(phase.id) ?? { usage: ZERO_USAGE, usd: 0 }
    const reportedUsd =
      phase.reportedCost === null
        ? null
        : Object.values(phase.reportedCost).reduce((sum, usd) => sum + usd, 0)
    const comparable = reportedUsd !== null && reportedUsd > 0 && !unpricedPhases.has(phase.id)
    const drift = comparable ? Math.abs(line.usd - reportedUsd) / reportedUsd : null
    return {
      phaseId: phase.id,
      name: phase.name,
      attempt: phase.attempt,
      ...line,
      reportedUsd,
      drift,
      flagged: drift !== null && drift > DRIFT_LIMIT,
    }
  })

  const allInput = totals.usage.input + totals.usage.cacheRead + totals.usage.cacheWrite
  return {
    totals,
    byPhase,
    byAgent: [...agents].map(([agent, line]) => ({ agent, ...line })).sort(byUsd),
    byModel: [...models].map(([model, line]) => ({ model, ...line })).sort(byUsd),
    cacheHitRatio: allInput === 0 ? null : totals.usage.cacheRead / allInput,
    missingPrices: [...missing].sort(),
  }
}
