import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardApi } from './api.js'
import type { Checkpoint, PhaseName, Stage, Work } from './contract.js'
import type { RunnerConfig } from './config.js'
import { GitError, type Git } from './git.js'
import { prepareLinked, removeLinked, restoreLinked } from './linked.js'
import type { PhaseDeps, PhaseInput, PhaseRecord, StepResult } from './phases/phase.js'
import { readPlanBase, writeExcluded, writePlanBase } from './phases/run-dir.js'
import { newEvent, type EventSink } from './sink.js'
import { runTestCommand } from './test-command.js'

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
  /** Runs a project command; the real one when absent. */
  runTests?: typeof runTestCommand
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
const NOTE_PATHS = 100

/** What the planner is told when the base moved since it last read the code. */
export function baseMovedNote(change: {
  from: string
  to: string
  commits: number
  paths: string[]
}): string {
  const listed = change.paths.slice(0, NOTE_PATHS)
  const more = change.paths.length - listed.length
  return [
    `The base branch moved while the run was paused. You last read the code at ${change.from}; it is now at ${change.to}, ${change.commits} ${change.commits === 1 ? 'commit' : 'commits'} later.`,
    'Paths changed between them:',
    ...listed,
    ...(more > 0 ? [`and ${more} more`] : []),
    'Check your plan against these changes, and save a revised plan with save_plan if the plan changes.',
  ].join('\n')
}

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

  const linkedDir = runPaths(deps.config.home, run.id).linked

  const send = (type: 'checkpoint' | 'error' | 'tool_call', fields: object) =>
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

  /**
   * The project's setup command, run in the fresh worktree before any phase starts, so the
   * repository's own rules (its dependencies) are there when the agents' sessions begin. A
   * failure or a timeout blocks the run in `prepare`; Resume runs the stage again.
   */
  const runSetup = async (command: string | null) => {
    if (command === null) return
    const result = await (deps.runTests ?? runTestCommand)(command, io.worktree, {
      timeoutMs: deps.config.testTimeoutMs,
    })
    const ok = result.exitCode === 0
    await send('tool_call', {
      tool: 'setup_command',
      target: command,
      status: ok ? 'ok' : 'error',
      duration_ms: result.durationMs,
      payload: {
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        truncated: result.truncated,
        output_tail: result.output.slice(-4_096),
      },
    })
    if (!ok) await block('step_failed', { command, output: result.output.slice(-4_096) })
  }

  /**
   * A checkout of each project this one links to, made once, in `prepare`: the run's links are
   * fixed there. A failed fetch or worktree is a `GitError`, which blocks the run.
   */
  const prepareLinkedCheckouts = () =>
    prepareLinked(deps.git, run.links ?? [], linkedDir, io.runDir)

  /** A resume past `prepare`: checkouts deleted while the run was paused are made again. */
  const restoreLinkedCheckouts = () => restoreLinked(deps.git, io.runDir)

  /**
   * A Plan-stage resume's refresh: the worktree and the linked checkouts move to the current
   * base, the runner's own uncommitted changes are undone first, and setup runs again. Returns
   * the note for a planner whose last read is not the new HEAD, or null.
   */
  const refreshBase = async (
    repo: string,
    base: string,
    setupCommand: string | null,
  ): Promise<string | null> => {
    await deps.git.fetchBase(repo, base)
    if (readPlanBase(io.runDir) === null) writePlanBase(io.runDir, await deps.git.head(io.worktree))
    await deps.git.undoUncommitted(io.worktree, base)
    await deps.git.fastForward(io.worktree, base)
    await prepareLinkedCheckouts()
    await runSetup(setupCommand)
    writeExcluded(
      io.runDir,
      setupCommand === null ? [] : (await deps.git.changedPaths(io.worktree, base)).uncommitted,
    )
    const from = readPlanBase(io.runDir)
    const to = await deps.git.head(io.worktree)
    if (from === null || from === to) return null
    return baseMovedNote({
      from,
      to,
      commits: await deps.git.commitCount(io.worktree, from, to),
      paths: await deps.git.changedBetween(io.worktree, from, to),
    })
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
  const phaseStep = async (
    name: PhaseOf,
    handoff: () => Promise<string>,
    options: { note?: string | null; delivered?: () => void } = {},
  ): Promise<StepResult> => {
    let result: StepResult
    // The planner's last read of the code, recorded before the process reads it again.
    const recordRead = async () => {
      if (name === 'plan') writePlanBase(io.runDir, await deps.git.head(io.worktree))
    }
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
      await recordRead()
      result = await deps.phases.start(
        { runId: run.id, phase: name, attempt: state.attempt, handoff: prompt, ...io },
        phaseDeps,
        ids,
      )
    } else {
      await recordRead()
      const message = `${options.note == null ? '' : `${options.note}\n\n`}${state.message ?? INTERRUPTED}`
      result = await deps.phases.resume(state.phase, message, io, phaseDeps)
      state.message = null
      if (result.sessionGone) {
        if (await deps.api.phaseHasMessages(run.id, state.phase.phaseId))
          throw new End('failed', SESSION_GONE)
        const prompt = await handoff()
        await recordRead()
        result = await deps.phases.restart(state.phase, prompt, io, phaseDeps)
      }
    }
    // Whatever the process did, it has had the answer: a pause, a cancel or a stop must not
    // leave it to be sent again.
    options.delivered?.()
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
        await removeLinked(deps.git, linkedDir, io.runDir).catch(() => undefined)
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
    runSetup,
    prepareLinkedCheckouts,
    restoreLinkedCheckouts,
    refreshBase,
    stopIfShuttingDown,
    phaseStep,
    endPhase,
    failPhase,
    carry,
  }
}

/** The run's directories, by the runner's own convention. */
export function runPaths(
  home: string,
  runId: string,
): { worktree: string; runDir: string; linked: string } {
  return {
    worktree: join(home, 'worktrees', runId),
    runDir: join(home, 'runs', runId),
    linked: join(home, 'worktrees', `${runId}-linked`),
  }
}
