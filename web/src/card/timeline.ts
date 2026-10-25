import type { EventView, PhaseView } from '../types'

/** The time a phase waited between pausing and resuming (slice 2 spec, §11). */
export interface Pause {
  kind: 'paused'
  id: string
  ms: number
}

export interface Band {
  phase: PhaseView
  steps: EventView[]
  /** The steps, with a pause before each resumed start. */
  entries: (EventView | Pause)[]
  tokens: number
}

const byTime =
  <T extends { ts?: string; started_at?: string }>(key: (x: T) => string) =>
  (a: T, b: T) =>
    key(a).localeCompare(key(b))

const isResume = (e: EventView) => e.type === 'phase_start' && e.payload.resumed === true

/**
 * A pause runs from the phase's last step before it stopped to its resumed start. The owner's
 * answer, which arrives just before the resume, is not where the pause began.
 */
function withPauses(steps: EventView[]): (EventView | Pause)[] {
  return steps.flatMap((step, index) => {
    if (!isResume(step)) return [step]
    const before = steps
      .slice(0, index)
      .filter((e) => e.type !== 'approval_answered')
      .at(-1)
    if (before === undefined) return [step]
    const ms = Date.parse(step.ts) - Date.parse(before.ts)
    return [{ kind: 'paused' as const, id: `pause-${step.id}`, ms }, step]
  })
}

/** A step's line, in words: a failure says so rather than only turning red. */
/** A run's name: drafts and delivery runs are numbered apart (slice 3 spec, §2). */
export function runLabel(run: { kind: string; number: number }): string {
  return `${run.kind === 'spec' ? 'Draft' : 'Run'} ${run.number}`
}

export function stepLabel(event: EventView): string {
  if (event.type === 'approval_requested') {
    const question = event.payload.question
    return `Asked: ${typeof question === 'string' ? question : 'a question'}`
  }
  if (event.type === 'approval_answered') return 'Answered'
  if (isResume(event)) return 'Resumed'
  const base =
    event.type === 'tool_call'
      ? `${event.tool ?? 'tool'} ${event.target ?? ''}`.trim()
      : event.type === 'message'
        ? `${event.agent ?? ''} message${event.payload.declared ? `: ${String(event.payload.summary)}` : ''}`.trim()
        : `${event.type.replaceAll('_', ' ')}${event.agent ? ` · ${event.agent}` : ''}`
  return event.status === 'error' ? `${base} · failed` : base
}

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
    return { phase, steps, entries: withPauses(steps), tokens }
  })
  const known = new Set(phases.map((p) => p.id))
  return { bands, loose: sortedEvents.filter((e) => e.phase_id === null || !known.has(e.phase_id)) }
}
