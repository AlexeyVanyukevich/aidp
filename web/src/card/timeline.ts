import type { EventView, PhaseView } from '../types'

export interface Band {
  phase: PhaseView
  steps: EventView[]
  tokens: number
}

const byTime =
  <T extends { ts?: string; started_at?: string }>(key: (x: T) => string) =>
  (a: T, b: T) =>
    key(a).localeCompare(key(b))

export function timelineModel(
  phases: PhaseView[],
  events: EventView[],
): { bands: Band[]; loose: EventView[] } {
  const sortedEvents = [...events].sort(byTime((e: EventView) => e.ts))
  const bands = [...phases].sort(byTime((p: PhaseView) => p.started_at)).map((phase) => {
    const steps = sortedEvents.filter((e) => e.phase_id === phase.id)
    const tokens = steps.reduce(
      (sum, e) => sum + e.usage.input + e.usage.output + e.usage.cache_read + e.usage.cache_write,
      0,
    )
    return { phase, steps, tokens }
  })
  const known = new Set(phases.map((p) => p.id))
  return { bands, loose: sortedEvents.filter((e) => e.phase_id === null || !known.has(e.phase_id)) }
}
