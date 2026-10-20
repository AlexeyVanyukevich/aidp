import { randomUUID } from 'node:crypto'
import type { BoardApi } from '../api.js'
import type { SessionTotals } from '../contract.js'
import { newEvent, type EventSink } from '../sink.js'
import { PHASES } from './agents.js'
import { runProcess, type ProcessResult, type ProcessTiming, type Stopped } from './process.js'

export interface PhaseInput {
  runId: string
  phase: 'plan' | 'build' | 'verify'
  attempt: number
  handoff: string
  worktree: string
  runDir: string
  budgetUsd: number | null
}

export interface PhaseDeps {
  api: BoardApi
  sink: EventSink
  claudeBin: string
  boardUrl: string
  signal?: AbortSignal
  shutdown?: AbortSignal
  pauseRequested?: () => boolean
  timing?: ProcessTiming
  /** The sink reads the token through this, so buffered events replay with a live one. */
  setToken(token: string): void
}

/**
 * One phase as the runner keeps it across its processes: one Claude Code session (slice 2
 * spec, §7), its last reported totals, the cost credited to it so far, and whether a process of
 * it was stopped. A checkpoint carries it from one runner to the next.
 */
export interface PhaseRecord {
  runId: string
  phaseId: string
  phase: 'plan' | 'build' | 'verify'
  attempt: number
  sessionId: string
  baseline: Record<string, SessionTotals>
  reported: Record<string, number>
  interrupted: boolean
  summary: string
}

export interface PhaseResult {
  phaseId: string
  ok: boolean
  summary: string
  sessionId: string | null
  cancelled: boolean
}

/** What one process of a phase came to. */
export interface StepResult {
  record: PhaseRecord
  ok: boolean
  stopped: Stopped
  /** `claude --resume` found no session (spec §3, facts 10 and 12). */
  sessionGone: boolean
}

const DEFAULT_TIMING: ProcessTiming = {
  pauseGraceMs: 60_000,
  stopGraceMs: 10_000,
  markerPollMs: 500,
}

async function step(
  record: PhaseRecord,
  prompt: string,
  resume: boolean,
  input: Pick<PhaseInput, 'worktree' | 'runDir' | 'budgetUsd'>,
  deps: PhaseDeps,
): Promise<StepResult> {
  const token = await deps.api.issueToken(record.runId)
  deps.setToken(token)
  const result: ProcessResult = await runProcess(
    {
      runId: record.runId,
      phaseId: record.phaseId,
      phase: record.phase,
      attempt: record.attempt,
      prompt,
      sessionId: record.sessionId,
      resume,
      worktree: input.worktree,
      runDir: input.runDir,
      budgetUsd: input.budgetUsd,
      baseline: record.baseline,
      token,
    },
    {
      sink: deps.sink,
      claudeBin: deps.claudeBin,
      boardUrl: deps.boardUrl,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      ...(deps.shutdown === undefined ? {} : { shutdown: deps.shutdown }),
      ...(deps.pauseRequested === undefined ? {} : { pauseRequested: deps.pauseRequested }),
      ...(deps.timing ?? DEFAULT_TIMING),
    },
  )
  await deps.api.retire(token).catch(() => undefined)
  const { normalizer } = result
  const reported = { ...record.reported }
  for (const [model, usd] of Object.entries(normalizer.reportedCost()))
    reported[model] = (reported[model] ?? 0) + usd
  const next: PhaseRecord = {
    ...record,
    sessionId: normalizer.sessionId ?? record.sessionId,
    baseline: normalizer.totals() ?? record.baseline,
    reported,
    interrupted: record.interrupted || result.interrupted,
    summary: normalizer.result?.text ?? record.summary,
  }
  const ok = result.exitCode === 0 && normalizer.result !== null && !normalizer.result.isError
  return { record: next, ok, stopped: result.stopped, sessionGone: normalizer.sessionGone }
}

/** Starts a phase on a new session: its `phase_start`, then its first process. */
export async function startPhase(
  input: PhaseInput,
  deps: PhaseDeps,
  ids: { phaseId?: string; sessionId?: string } = {},
): Promise<StepResult> {
  const config = PHASES[input.phase]
  const record: PhaseRecord = {
    runId: input.runId,
    phaseId: ids.phaseId ?? randomUUID(),
    phase: input.phase,
    attempt: input.attempt,
    sessionId: ids.sessionId ?? randomUUID(),
    baseline: {},
    reported: {},
    interrupted: false,
    summary: '',
  }
  // The token the start event travels with; the process gets its own.
  deps.setToken(await deps.api.issueToken(input.runId))
  await deps.sink.send([
    newEvent(
      {
        runId: input.runId,
        phaseId: record.phaseId,
        agent: config.agent,
        type: 'phase_start',
        model: config.model,
      },
      { payload: { name: input.phase, attempt: input.attempt, session_id: record.sessionId } },
    ),
  ])
  return step(record, input.handoff, false, input, deps)
}

/** Resumes a phase's session with `message`, in the same phase row (spec §6). */
export async function continuePhase(
  record: PhaseRecord,
  message: string,
  input: Pick<PhaseInput, 'worktree' | 'runDir' | 'budgetUsd'>,
  deps: PhaseDeps,
): Promise<StepResult> {
  const config = PHASES[record.phase]
  deps.setToken(await deps.api.issueToken(record.runId))
  await deps.sink.send([
    newEvent(
      {
        runId: record.runId,
        phaseId: record.phaseId,
        agent: config.agent,
        type: 'phase_start',
        model: config.model,
      },
      {
        payload: {
          name: record.phase,
          attempt: record.attempt,
          session_id: record.sessionId,
          resumed: true,
        },
      },
    ),
  ])
  return step(record, message, true, input, deps)
}

/** Ends a phase: its cost as the sum of its processes' shares, and whether one was stopped. */
export async function endPhase(record: PhaseRecord, ok: boolean, deps: PhaseDeps): Promise<void> {
  const config = PHASES[record.phase]
  await deps.sink.send([
    newEvent(
      { runId: record.runId, phaseId: record.phaseId, agent: config.agent, type: 'phase_end' },
      {
        payload: {
          status: ok ? 'succeeded' : 'failed',
          summary_md: record.summary,
          reported_cost: record.reported,
          session_id: record.sessionId,
          ...(record.interrupted ? { interrupted: true } : {}),
        },
      },
    ),
  ])
}

/** Slice 1's whole phase in one call: start it, let its one process run, end it. */
export async function runPhase(input: PhaseInput, deps: PhaseDeps): Promise<PhaseResult> {
  const { record, ok, stopped } = await startPhase(input, deps)
  const cancelled = stopped === 'cancelled'
  await endPhase(record, ok && !cancelled, deps)
  return {
    phaseId: record.phaseId,
    ok: ok && !cancelled,
    summary: record.summary,
    sessionId: record.sessionId,
    cancelled,
  }
}
