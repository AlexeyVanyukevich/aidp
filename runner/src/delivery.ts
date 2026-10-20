import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardApi } from './api.js'
import type { Checkpoint, PlanData, ReportData, RunView, Stage, Work } from './contract.js'
import type { RunnerConfig } from './config.js'
import { GitError, type Git } from './git.js'
import { buildHandoff, type HandoffInput } from './phases/handoff.js'
import type { PhaseDeps, PhaseInput, PhaseRecord, StepResult } from './phases/phase.js'
import { prepareRunDir, writeAllowedFiles } from './phases/run-dir.js'
import { newEvent, type EventSink } from './sink.js'
import type { runTestCommand } from './test-command.js'

type Io = Pick<PhaseInput, 'worktree' | 'runDir' | 'budgetUsd'>

/** The phase calls delivery makes, injected so the stages are testable without a process. */
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

export interface DeliveryDeps {
  api: BoardApi
  git: Git
  sink: EventSink
  setToken(token: string): void
  phases: Phases
  runTests: typeof runTestCommand
  config: RunnerConfig
  /** The owner cancelled the run. */
  signal: AbortSignal
  /** The daemon is stopping: the run is blocked, to be resumed (spec §8). */
  shutdown?: AbortSignal
  /** The heartbeat said the run paused. */
  pauseRequested?: () => boolean
}

/** `released`: paused or blocked — the worktree kept, no `run_end`, the run resumable. */
export type Outcome = 'review' | 'failed' | 'cancelled' | 'released'

const MAX_ATTEMPTS = 3
/** A checkpoint's failing report when the build made no commit: there is no report to name. */
const NO_COMMIT = 'no_commit'
const NO_COMMIT_TEXT = 'The build made no commit, so there was nothing to verify. Commit your work.'
export const INTERRUPTED = 'You were interrupted. Continue from where you stopped.'
const PLAN_QUESTION =
  'The planner is not confident in this plan. Approve it, or say what to change.'
const SESSION_GONE = "the run's Claude Code session is gone; Re-run starts again from Plan"

/** Ends the run: caught once, at the bottom. */
class End extends Error {
  constructor(
    readonly outcome: 'failed' | 'cancelled',
    readonly reason: string | null,
  ) {
    super(reason ?? outcome)
  }
}
/** Stops carrying the run out without ending it: it paused, or it is blocked. */
class Release extends Error {}

interface State {
  stage: Stage
  attempt: number
  phase: PhaseRecord | null
  planId: string | null
  failingId: string | null
}

function stateOf(checkpoint: Checkpoint, runId: string): State {
  const { stage, session, phase_id: phaseId } = checkpoint
  const phaseName = stage === 'plan' || stage === 'build' || stage === 'verify' ? stage : null
  return {
    stage,
    attempt: checkpoint.attempt,
    phase:
      phaseName === null || session === null || phaseId === null
        ? null
        : {
            runId,
            phaseId,
            phase: phaseName,
            attempt: checkpoint.attempt,
            sessionId: session.id,
            baseline: session.baseline,
            reported: session.reported,
            interrupted: session.interrupted === true,
            summary: '',
          },
    planId: checkpoint.plan_artifact_id,
    failingId: checkpoint.failing_report_id,
  }
}

/**
 * Carries a delivery run out from where it stands (slice 2 spec, §6): from the start, or from a
 * checkpoint with the owner's answer or a nudge. Each stage sends a checkpoint as it begins and
 * after each process, so a runner that dies leaves the next one where to start.
 */
export async function carryOut(
  work: Extract<Work, { kind: 'start' | 'resume' }>,
  deps: DeliveryDeps,
): Promise<Outcome> {
  const { run } = work
  const { project, task } = run
  const branch = `board/${task.key}-r${run.number}`
  const worktree = join(deps.config.home, 'worktrees', run.id)
  const runDir = join(deps.config.home, 'runs', run.id)
  const io: Io = { worktree, runDir, budgetUsd: task.budget_usd }
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
  const state: State =
    work.kind === 'start'
      ? { stage: 'prepare', attempt: 1, phase: null, planId: null, failingId: null }
      : stateOf(work.checkpoint, run.id)
  /** The answer or nudge for the phase a resume continues; null once used, or for a plan approved. */
  let message: string | null = work.kind === 'resume' ? work.message : null
  let testOutput: string | undefined
  let latestRun: RunView | undefined

  const send = (type: 'checkpoint' | 'error' | 'tool_call', fields: object) =>
    deps.sink.send([newEvent({ runId: run.id, phaseId: null, type }, fields)])
  const checkpoint = async () => {
    let head: string | null = null
    if (existsSync(worktree)) head = await deps.git.head(worktree).catch(() => null)
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
  const getRun = async () => (latestRun = await deps.api.getRun(run.id))
  const artifact = async (kind: 'plan' | 'verify_report', by: { phaseId?: string; id?: string }) =>
    (await getRun()).artifacts
      .filter((a) => a.kind === kind)
      .filter((a) => by.id === undefined || a.id === by.id)
      .filter((a) => by.phaseId === undefined || a.phase_id === by.phaseId)
      .at(-1)

  const summaries = async (): Promise<HandoffInput['summaries']> =>
    (latestRun ?? (await getRun())).phases
      .filter((p) => p.status === 'succeeded' && p.summary_md !== null)
      .map((p) => ({ phase: p.name, attempt: p.attempt, text: p.summary_md ?? '' }))

  const tests = async () => {
    const result = await deps.runTests(project.test_command, worktree, {
      timeoutMs: deps.config.testTimeoutMs,
    })
    await deps.sink.send([
      newEvent(
        { runId: run.id, phaseId: null, type: 'tool_call', agent: 'runner' },
        {
          tool: 'test_command',
          target: project.test_command,
          status: result.exitCode === 0 ? 'ok' : 'error',
          duration_ms: result.durationMs,
          payload: {
            exit_code: result.exitCode,
            timed_out: result.timedOut,
            truncated: result.truncated,
            output_tail: result.output.slice(-4_096),
          },
        },
      ),
    ])
    testOutput = `exit code: ${result.timedOut ? 'killed after timeout' : String(result.exitCode)}\n${result.truncated ? '[output cut to its end]\n' : ''}${result.output}`
  }

  const handoffFor = async (
    name: 'plan' | 'build' | 'verify',
    attempt: number,
  ): Promise<string> => {
    const common = {
      taskKey: task.key,
      title: task.title,
      specVersion: run.spec.version,
      specMd: run.spec.body_md,
      budgetUsd: task.budget_usd,
      phase: name,
      attempt,
      summaries: await summaries(),
    }
    if (name === 'plan') return buildHandoff(common)
    const plan = state.planId === null ? undefined : await artifact('plan', { id: state.planId })
    if (plan === undefined) throw new End('failed', 'the run has no plan to work from')
    if (name === 'build') {
      const failing =
        state.failingId === null
          ? undefined
          : state.failingId === NO_COMMIT
            ? NO_COMMIT_TEXT
            : (await artifact('verify_report', { id: state.failingId }))?.body_md
      return buildHandoff({
        ...common,
        plan: plan.body_md,
        ...(failing === undefined ? {} : { verifyReport: failing }),
      })
    }
    // A Verify started afresh after a resume has no test output yet: the tests run again.
    if (testOutput === undefined) await tests()
    return buildHandoff({
      ...common,
      plan: plan.body_md,
      testOutput: testOutput ?? '',
      diff: await deps.git.diff(worktree, project.base_branch),
    })
  }

  /**
   * One process of the current stage's phase: starting it, continuing its session, or — when
   * that session is gone with nothing in it — starting it again. Returns once the process ended
   * by itself; a pause, a cancel or a stop leaves through `Release` or `End`.
   */
  const phaseStep = async (name: 'plan' | 'build' | 'verify'): Promise<StepResult> => {
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
      const handoff = await handoffFor(name, state.attempt)
      await checkpoint()
      result = await deps.phases.start(
        { runId: run.id, phase: name, attempt: state.attempt, handoff, ...io },
        phaseDeps,
        ids,
      )
    } else {
      result = await deps.phases.resume(state.phase, message ?? INTERRUPTED, io, phaseDeps)
      message = null
      if (result.sessionGone) {
        if (await deps.api.phaseHasMessages(run.id, state.phase.phaseId))
          throw new End('failed', SESSION_GONE)
        result = await deps.phases.restart(
          state.phase,
          await handoffFor(name, state.attempt),
          io,
          phaseDeps,
        )
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
  const failPhase = async (name: string): Promise<never> => {
    await endPhase(false)
    throw new End(
      'failed',
      state.attempt === 1 && name !== 'build'
        ? `the ${name} phase failed`
        : `the ${name} phase failed on attempt ${state.attempt}`,
    )
  }
  const nextAttempt = (failingId: string) => {
    if (state.attempt >= MAX_ATTEMPTS) throw new End('failed', 'verify failed three times')
    state.attempt += 1
    state.failingId = failingId
    state.stage = 'build'
    testOutput = undefined
  }
  /** After an accepted plan: Build may change its files, and any the owner allowed since. */
  const allowPlanFiles = async () => {
    const plan = state.planId === null ? undefined : await artifact('plan', { id: state.planId })
    const files = (plan?.data as PlanData | undefined)?.steps.flatMap((s) => s.files) ?? []
    const allowed = work.kind === 'resume' ? work.allowed_files : []
    writeAllowedFiles(runDir, [...new Set([...files, ...allowed])])
  }

  let outcome: Outcome = 'failed'
  let extra: Record<string, unknown> = {}
  try {
    deps.setToken(await deps.api.issueToken(run.id))
    if (run.kind !== 'delivery') throw new End('failed', 'spec runs arrive in slice 3')
    prepareRunDir(runDir)
    if (work.kind === 'resume') {
      if (work.allowed_files.length > 0) writeAllowedFiles(runDir, work.allowed_files)
      if (state.stage !== 'prepare') {
        const there =
          existsSync(worktree) &&
          (await deps.git.currentBranch(worktree).catch(() => null)) === branch
        if (!there) throw new End('failed', "the run's worktree is gone")
      }
    }

    for (;;) {
      await stopIfShuttingDown()
      switch (state.stage) {
        case 'prepare': {
          await checkpoint()
          if (work.kind === 'resume') {
            // A prepare that stopped partway may have left either half behind.
            await deps.git.removeWorktree(project.repo_path, worktree).catch(() => undefined)
            await deps.git.deleteBranch(project.repo_path, branch).catch(() => undefined)
          }
          await deps.git.prepareWorktree(project.repo_path, project.base_branch, branch, worktree)
          state.stage = 'plan'
          state.attempt = 1
          break
        }
        case 'plan': {
          // A plan the owner approved at the gate: the phase ends, and Build starts (spec §5).
          if (state.phase !== null && message === null && work.kind === 'resume') {
            await endPhase(true)
            await allowPlanFiles()
            state.stage = 'build'
            state.attempt = 1
            break
          }
          const result = await phaseStep('plan')
          if (!result.ok) await failPhase('plan')
          const plan = await artifact('plan', { phaseId: result.record.phaseId })
          if (plan === undefined) {
            await endPhase(false)
            throw new End('failed', 'the planner saved no plan')
          }
          state.planId = plan.id
          if ((plan.data as PlanData).confidence !== 'high') {
            await checkpoint()
            await deps.sink.send([
              newEvent(
                { runId: run.id, phaseId: result.record.phaseId, type: 'approval_requested' },
                {
                  payload: {
                    approval_id: randomUUID(),
                    kind: 'plan',
                    question: PLAN_QUESTION,
                    context_md: plan.body_md,
                  },
                },
              ),
            ])
            throw new Release()
          }
          await endPhase(true)
          await allowPlanFiles()
          state.stage = 'build'
          state.attempt = 1
          break
        }
        case 'build': {
          const result = await phaseStep('build')
          if (!result.ok) await failPhase('build')
          await endPhase(true)
          state.stage = 'tests'
          break
        }
        case 'tests': {
          await checkpoint()
          const commits = await deps.git.newCommits(worktree, project.base_branch)
          await tests()
          await stopIfShuttingDown()
          if (commits === 0) nextAttempt(NO_COMMIT)
          else state.stage = 'verify'
          break
        }
        case 'verify': {
          const result = await phaseStep('verify')
          if (!result.ok) await failPhase('verify')
          const report = await artifact('verify_report', { phaseId: result.record.phaseId })
          if (report === undefined) {
            await endPhase(false)
            throw new End('failed', 'the verifier saved no report')
          }
          await endPhase(true)
          if ((report.data as ReportData).criteria.every((c) => c.status === 'pass'))
            state.stage = 'push'
          else nextAttempt(report.id)
          break
        }
        case 'push': {
          await checkpoint()
          await deps.git.push(worktree, branch)
          state.stage = 'pr'
          break
        }
        case 'pr': {
          await checkpoint()
          const report = (await getRun()).artifacts.filter((a) => a.kind === 'verify_report').at(-1)
          // A run stopped after `gh pr create` already has its pull request: it is taken.
          const pr =
            (await deps.git.findPr(worktree, { githubRepo: project.github_repo, branch })) ??
            (await deps.git.createPr(worktree, {
              githubRepo: project.github_repo,
              base: project.base_branch,
              branch,
              title: `${task.key}: ${task.title}`,
              body: `${task.key}, run ${run.number}, spec v${run.spec.version}.\n\n## Verify report\n\n${report?.body_md ?? ''}\n`,
            }))
          outcome = 'review'
          extra = { pr_number: pr.number, pr_url: pr.url }
          return outcome
        }
      }
    }
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
    return outcome
  } finally {
    if (outcome !== 'released') {
      await deps.git.removeWorktree(project.repo_path, worktree).catch(() => undefined)
      await deps.sink.send([
        newEvent(
          { runId: run.id, phaseId: null, type: 'run_end' },
          { payload: { outcome, branch, worktree_path: worktree, ...extra } },
        ),
      ])
    }
  }
}

/**
 * A run cancelled while paused or blocked: its worktree goes; the board has already ended it.
 * The path is the runner's own convention, since the board learns a worktree's path only from a
 * run's end.
 */
export async function cleanUp(
  work: Extract<Work, { kind: 'cleanup' }>,
  deps: Pick<DeliveryDeps, 'git' | 'config'>,
): Promise<void> {
  const worktree = work.run.worktree_path ?? join(deps.config.home, 'worktrees', work.run.id)
  if (!existsSync(worktree)) return
  await deps.git.removeWorktree(work.run.repo_path, worktree).catch(() => undefined)
}
