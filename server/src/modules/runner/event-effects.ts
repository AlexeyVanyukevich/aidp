import { ValidationError } from '../../shared/errors.js'
import {
  PHASE_NAMES,
  STAGES,
  type Block,
  type Checkpoint,
  type PhaseName,
  type SessionTotals,
} from '../../shared/vocabulary.js'
import type { RunnerEvent } from './runner.schemas.js'

/** A failed step's output is kept to its end, where the error usually is. */
export const BLOCK_OUTPUT_LIMIT = 8_000

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
      interrupted: boolean
      at: Date
    }
  /** A phase that paused or was blocked runs again, in the same row. */
  | { kind: 'phase_resume'; phaseId: string; sessionId: string | null; at: Date }
  | { kind: 'checkpoint'; checkpoint: Checkpoint }
  | { kind: 'block'; block: Block }
  /** The runner's plan gate; agents ask through the MCP tool instead. */
  | {
      kind: 'plan_approval'
      approvalId: string
      phaseId: string
      question: string
      contextMd: string | null
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
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

function sessionOf(event: RunnerEvent, value: unknown): Checkpoint['session'] {
  if (value === null) return null
  if (!isObject(value) || typeof value.id !== 'string') bad(event, 'session must be an object')
  const baseline: Record<string, SessionTotals> = {}
  for (const [model, totals] of Object.entries(isObject(value.baseline) ? value.baseline : {})) {
    const keys = ['input', 'output', 'cache_read', 'cache_write', 'usd'] as const
    if (!isObject(totals) || !keys.every((key) => isCount(totals[key])))
      bad(event, `session.baseline.${model} is not usage`)
    baseline[model] = {
      input: totals.input as number,
      output: totals.output as number,
      cache_read: totals.cache_read as number,
      cache_write: totals.cache_write as number,
      usd: totals.usd as number,
    }
  }
  return {
    id: value.id,
    baseline,
    reported: costMap(event, value.reported) ?? {},
    ...(value.interrupted === true ? { interrupted: true } : {}),
  }
}

function checkpointOf(event: RunnerEvent): Checkpoint {
  const p = event.payload
  const stage = STAGES.find((known) => known === p.stage)
  if (stage === undefined) bad(event, 'stage is not a stage')
  if (typeof p.attempt !== 'number' || !Number.isInteger(p.attempt) || p.attempt < 1)
    bad(event, 'attempt must be 1 or more')
  return {
    stage,
    attempt: p.attempt,
    phase_id: text(p.phase_id),
    session: sessionOf(event, p.session ?? null),
    head: text(p.head),
    plan_artifact_id: text(p.plan_artifact_id),
    failing_report_id: text(p.failing_report_id),
  }
}

/** The runner blocks a run for a failed step or for being stopped; the rest are the sweeper's. */
function blockOf(event: RunnerEvent): Block {
  const p = event.payload
  const stage = p.stage === null ? null : STAGES.find((known) => known === p.stage)
  if (stage === undefined) bad(event, 'stage is not a stage')
  if (p.cause === 'runner_stopped') return { cause: 'runner_stopped', stage }
  if (p.cause !== 'step_failed')
    bad(event, 'the runner blocks only for step_failed or runner_stopped')
  const command = text(p.command)
  const output = text(p.output)
  if (command === null || output === null) bad(event, 'a failed step needs its command and output')
  return { cause: 'step_failed', stage, command, output: output.slice(-BLOCK_OUTPUT_LIMIT) }
}

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
      if (p.resumed === true) {
        if (phaseId === null) bad(event, 'phase_id is required')
        return { kind: 'phase_resume', phaseId, sessionId: text(p.session_id), at }
      }
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
        interrupted: p.interrupted === true,
        at,
      }
    }
    case 'checkpoint':
      return { kind: 'checkpoint', checkpoint: checkpointOf(event) }
    case 'error':
      // An error that blocks the run says so; any other is a timeline entry only.
      return p.blocks === true ? { kind: 'block', block: blockOf(event) } : undefined
    case 'approval_requested': {
      if (p.kind !== 'plan') bad(event, 'the runner raises only the plan gate’s approvals')
      const approvalId = text(p.approval_id)
      const question = text(p.question)
      if (approvalId === null || question === null)
        bad(event, 'approval_id and question are required')
      if (event.phase_id === null) bad(event, 'phase_id is required')
      return {
        kind: 'plan_approval',
        approvalId,
        phaseId: event.phase_id,
        question,
        contextMd: text(p.context_md),
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
