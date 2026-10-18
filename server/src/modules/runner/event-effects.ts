import { ValidationError } from '../../shared/errors.js'
import { PHASE_NAMES, type PhaseName } from '../../shared/vocabulary.js'
import type { RunnerEvent } from './runner.schemas.js'

export type Effect =
  | {
      kind: 'phase_start'
      phaseId: string
      name: PhaseName
      attempt: number
      agent: string
      model: string
      sessionId: string | null
      at: Date
    }
  | {
      kind: 'phase_end'
      phaseId: string
      status: 'succeeded' | 'failed'
      summary: string | null
      reportedCost: Record<string, number> | null
      sessionId: string | null
      at: Date
    }
  | {
      kind: 'run_end'
      outcome: 'review' | 'failed' | 'cancelled'
      reason: string | null
      prNumber: number | null
      prUrl: string | null
      branch: string | null
      worktreePath: string | null
      at: Date
    }

function bad(event: RunnerEvent, why: string): never {
  throw new ValidationError(`Invalid ${event.type} payload: ${why}`, { event_id: event.id })
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function costMap(event: RunnerEvent, value: unknown): Record<string, number> | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') bad(event, 'reported_cost must be an object')
  const result: Record<string, number> = {}
  for (const [model, usd] of Object.entries(value)) {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0)
      bad(event, `reported_cost.${model} is not a cost`)
    result[model] = usd
  }
  return result
}

/** What a stored event changes beyond its own row. Pure: the service applies it. */
export function effectOf(event: RunnerEvent): Effect | undefined {
  const p = event.payload
  const at = new Date(event.ts)
  switch (event.type) {
    case 'phase_start': {
      const { phase_id: phaseId, agent, model } = event
      const name = PHASE_NAMES.find((known) => known === p.name)
      const attempt = typeof p.attempt === 'number' && Number.isInteger(p.attempt) ? p.attempt : 0
      if (phaseId === null) bad(event, 'phase_id is required')
      if (name === undefined) bad(event, 'name is not a phase')
      if (attempt < 1) bad(event, 'attempt must be 1 or more')
      if (agent === null || model === null) bad(event, 'agent and model are required')
      return {
        kind: 'phase_start',
        phaseId,
        name,
        attempt,
        agent,
        model,
        sessionId: text(p.session_id),
        at,
      }
    }
    case 'phase_end': {
      const phaseId = event.phase_id
      const status = p.status === 'succeeded' || p.status === 'failed' ? p.status : undefined
      if (phaseId === null) bad(event, 'phase_id is required')
      if (status === undefined) bad(event, 'status must be succeeded or failed')
      return {
        kind: 'phase_end',
        phaseId,
        status,
        summary: text(p.summary_md),
        reportedCost: costMap(event, p.reported_cost),
        sessionId: text(p.session_id),
        at,
      }
    }
    case 'run_end': {
      const outcome =
        p.outcome === 'review' || p.outcome === 'failed' || p.outcome === 'cancelled'
          ? p.outcome
          : undefined
      if (outcome === undefined) bad(event, 'outcome must be review, failed or cancelled')
      const prNumber =
        typeof p.pr_number === 'number' && Number.isInteger(p.pr_number) ? p.pr_number : null
      const prUrl = text(p.pr_url)
      if (outcome === 'review' && (prNumber === null || prUrl === null))
        bad(event, 'a review needs pr_number and pr_url')
      return {
        kind: 'run_end',
        outcome,
        reason: text(p.reason),
        prNumber,
        prUrl,
        branch: text(p.branch),
        worktreePath: text(p.worktree_path),
        at,
      }
    }
    default:
      return undefined
  }
}
