import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardApi } from './api.js'
import type { Checkpoint, PhaseName, Stage, Work } from './contract.js'
import type { RunnerConfig } from './config.js'
import { GitError, type Git } from './git.js'
import type { PhaseDeps, PhaseInput, PhaseRecord, StepResult } from './phases/phase.js'
import { newEvent, type EventSink } from './sink.js'

export type Io = Pick<PhaseInput, 'worktree' | 'runDir' | 'budgetUsd'>
type PhaseOf = PhaseRecord['phase']

/** The phase calls a run makes, injected so the stages are testable without a process. */
export interface Phases {
  start(
    input: PhaseInput,
    deps: PhaseDeps,
    ids: { phaseId: string; sessionId: string },
  ): Promise<StepResult>
  resume(record: PhaseRecord, message: string, io: Io, deps: PhaseDeps): Promise<StepResult>
  restart(record: PhaseRecord, handoff: string, io: Io, deps: PhaseDeps): Promise<StepResult>
  end(record: PhaseRecord, ok: boolean, deps: PhaseDeps): Promise<void>
}

/** What carrying out any run needs. */
export interface RunDeps {
  api: BoardApi
  git: Git
  sink: EventSink
  setToken(token: string): void
  phases: Phases
  config: RunnerConfig
  /** The owner cancelled the run. */
  signal: AbortSignal
  /** The daemon is stopping: the run is blocked, to be resumed (slice 2 spec, §8). */
  shutdown?: AbortSignal
  /** The heartbeat said the run paused. */
  pauseRequested?: () => boolean
}

/** `released`: paused or blocked — the worktree kept, no `run_end`, the run resumable. */
export type Outcome = 'review' | 'failed' | 'cancelled' | 'released'

export const INTERRUPTED = 'You were interrupted. Continue from where you stopped.'
const SESSION_GONE = "the run's Claude Code session is gone; Re-run starts again from Plan"

/** Ends the run: caught once, at the bottom. */
export class End extends Error {
  constructor(
    readonly outcome: 'failed' | 'cancelled',
    readonly reason: string | null,
  ) {
    super(reason ?? outcome)
  }
}
/** Stops carrying the run out without ending it: it paused, or it is blocked. */
export class Release extends Error {}

export interface State {
  stage: Stage
  attempt: number
  phase: PhaseRecord | null
  planId: string | null
  failingId: string | null
  /** The answer or nudge for the phase a resume continues; null once used, or for a plan approved. */
  message: string | null
}

const PHASE_STAGES: readonly Stage[] = ['spec', 'plan', 'build', 'verify']
const isPhase = (stage: Stage): stage is PhaseOf & Stage => PHASE_STAGES.includes(stage)

/** Where a run stands: from the start, or from a checkpoint with the answer or a nudge. */
export function stateOf(work: Extract<Work, { kind: 'start' | 'resume' }>): State {
  if (work.kind === 'start')
    return {
      stage: 'prepare',
      attempt: 1,
      phase: null,
      planId: null,
      failingId: null,
      message: null,
    }
  const { checkpoint } = work
  const { stage, session, phase_id: phaseId } = checkpoint
  return {
    stage,
    attempt: checkpoint.attempt,
    phase:
      !isPhase(stage) || session === null || phaseId === null
        ? null
        : {
            runId: work.run.id,
            phaseId,
            phase: stage,
            attempt: checkpoint.attempt,
            sessionId: session.id,
            baseline: session.baseline,
            reported: session.reported,
            interrupted: session.interrupted === true,
            summary: '',
          },
    planId: checkpoint.plan_artifact_id,
    failingId: checkpoint.failing_report_id,
    message: work.message,
  }
}

/**
 * The machinery every run's stages share (slice 2 spec, §6): a checkpoint as each stage begins
 * and after each process, a block where the run stands, one process of a phase, and its end.
 */
export function runSteps(work: Extract<Work, { kind: 'start' | 'resume' }>, deps: RunDeps, io: Io) {
  const { run } = work
  const state = stateOf(work)
  const phaseDeps: PhaseDeps = {
    api: deps.api,
    sink: deps.sink,
    claudeBin: deps.config.claudeBin,
    boardUrl: deps.config.boardUrl,
    signal: deps.signal,
    ...(deps.shutdown === undefined ? {} : { shutdown: deps.shutdown }),
    ...(deps.pauseRequested === undefined ? {} : { pauseRequested: deps.pauseRequested }),
    timing: {
      pauseGraceMs: deps.config.pauseGraceMs,
      stopGraceMs: deps.config.stopGraceMs,
      markerPollMs: deps.config.markerPollMs,
    },
    setToken: deps.setToken,
  }

  const send = (type: 'checkpoint' | 'error', fields: object) =>
    deps.sink.send([newEvent({ runId: run.id, phaseId: null, type }, fields)])

  const checkpoint = async () => {
    let head: string | null = null
    if (existsSync(io.worktree)) head = await deps.git.head(io.worktree).catch(() => null)
    const payload: Checkpoint = {
      stage: state.stage,
      attempt: state.attempt,
      phase_id: state.phase?.phaseId ?? null,
      session:
        state.phase === null
          ? null
          : {
              id: state.phase.sessionId,
              baseline: state.phase.baseline,
              reported: state.phase.reported,
              ...(state.phase.interrupted ? { interrupted: true } : {}),
            },
      head,
      plan_artifact_id: state.planId,
      failing_report_id: state.failingId,
    }
    await send('checkpoint', { payload })
  }

  const block = async (
    cause: 'step_failed' | 'runner_stopped',
    detail: { command?: string; output?: string } = {},
  ): Promise<never> => {
    await checkpoint()
    await send('error', { payload: { blocks: true, cause, stage: state.stage, ...detail } })
    throw new Release()
  }

  /** The daemon is stopping: between steps, the run is blocked where it stands. */
  const stopIfShuttingDown = async () => {
    if (deps.shutdown?.aborted === true) await block('runner_stopped')
  }

  /**
   * One process of the current stage's phase: starting it, continuing its session, or — when
   * that session is gone with nothing in it — starting it again. Returns once the process ended
   * by itself; a pause, a cancel or a stop leaves through `Release` or `End`.
   */
  const phaseStep = async (name: PhaseOf, handoff: () => Promise<string>): Promise<StepResult> => {
    let result: StepResult
    if (state.phase === null) {
      // The ids first, so the checkpoint names the phase and session before the process starts.
      const ids = { phaseId: randomUUID(), sessionId: randomUUID() }
      state.phase = {
        runId: run.id,
        phaseId: ids.phaseId,
        phase: name,
        attempt: state.attempt,
        sessionId: ids.sessionId,
        baseline: {},
        reported: {},
        interrupted: false,
        summary: '',
      }
      const prompt = await handoff()
      await checkpoint()
      result = await deps.phases.start(
        { runId: run.id, phase: name, attempt: state.attempt, handoff: prompt, ...io },
        phaseDeps,
        ids,
      )
    } else {
      result = await deps.phases.resume(state.phase, state.message ?? INTERRUPTED, io, phaseDeps)
      state.message = null
      if (result.sessionGone) {
        if (await deps.api.phaseHasMessages(run.id, state.phase.phaseId))
          throw new End('failed', SESSION_GONE)
        result = await deps.phases.restart(state.phase, await handoff(), io, phaseDeps)
      }
    }
    state.phase = result.record
    await checkpoint()
    if (result.stopped === 'cancelled') throw new End('cancelled', 'cancelled by the owner')
    if (result.stopped === 'shutdown') await block('runner_stopped')
    if (result.stopped === 'paused') throw new Release()
    return result
  }

  const endPhase = async (ok: boolean) => {
    if (state.phase !== null) await deps.phases.end(state.phase, ok, phaseDeps)
    state.phase = null
  }

  const failPhase = async (name: PhaseName): Promise<never> => {
    await endPhase(false)
    throw new End(
      'failed',
      state.attempt === 1 && name !== 'build'
        ? `the ${name} phase failed`
        : `the ${name} phase failed on attempt ${state.attempt}`,
    )
  }

  /**
   * Carries the run's stages out and settles it: a git or gh step that failed blocks the run
   * where it stands, `End` ends it, `Release` leaves it resumable. A run that ended removes its
   * worktree and reports its `run_end`.
   */
  const carry = async <Done extends string>(
    where: { repo: string; branch: string | null },
    stages: () => Promise<{ outcome: Done; extra: Record<string, unknown> }>,
  ): Promise<Done | Exclude<Outcome, 'review'>> => {
    let outcome: Done | Exclude<Outcome, 'review'> = 'failed'
    let extra: Record<string, unknown> = {}
    try {
      deps.setToken(await deps.api.issueToken(run.id))
      const done = await stages()
      outcome = done.outcome
      extra = done.extra
    } catch (error) {
      if (error instanceof Release) {
        outcome = 'released'
      } else if (error instanceof GitError) {
        // A git or gh step that failed blocks the run where it stands; Resume retries the step.
        outcome = 'released'
        await block('step_failed', { command: error.command, output: error.output }).catch(
          () => undefined,
        )
      } else if (error instanceof End) {
        outcome = error.outcome
        extra = { reason: error.reason }
      } else {
        outcome = 'failed'
        extra = { reason: error instanceof Error ? error.message : String(error) }
      }
    } finally {
      if (outcome !== 'released') {
        await deps.git.removeWorktree(where.repo, io.worktree).catch(() => undefined)
        await deps.sink.send([
          newEvent(
            { runId: run.id, phaseId: null, type: 'run_end' },
            {
              payload: {
                outcome,
                ...(where.branch === null ? {} : { branch: where.branch }),
                worktree_path: io.worktree,
                ...extra,
              },
            },
          ),
        ])
      }
    }
    return outcome
  }

  return {
    state,
    checkpoint,
    block,
    stopIfShuttingDown,
    phaseStep,
    endPhase,
    failPhase,
    carry,
  }
}

/** The run's directories, by the runner's own convention. */
export function runPaths(home: string, runId: string): { worktree: string; runDir: string } {
  return { worktree: join(home, 'worktrees', runId), runDir: join(home, 'runs', runId) }
}
