import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlanData, ReportData, RunView, Work } from './contract.js'
import type { RunnerConfig } from './config.js'
import type { Git } from './git.js'
import { buildHandoff, type HandoffInput } from './phases/handoff.js'
import { formatViolations, newlyChanged, violationsOf } from './files-gate.js'
import {
  GATE_REPORT,
  prepareRunDir,
  readAllowed,
  readApproved,
  readExcluded,
  writeAllowedFiles,
  writeApprovedMigrations,
  writeBaseBranch,
  writeExcluded,
} from './phases/run-dir.js'
import { End, Release, runPaths, runSteps, type Outcome, type RunDeps } from './run-steps.js'
import { ApiError } from './api.js'
import { linkedForHandoff, removeLinked } from './linked.js'
import { newEvent } from './sink.js'
import type { runTestCommand } from './test-command.js'

export { INTERRUPTED, type Outcome, type Phases } from './run-steps.js'

export interface DeliveryDeps extends RunDeps {
  runTests: typeof runTestCommand
}

const MAX_ATTEMPTS = 3
/** A checkpoint's failing report when the build made no commit: there is no report to name. */
const NO_COMMIT = 'no_commit'
const NO_COMMIT_TEXT = 'The build made no commit, so there was nothing to verify. Commit your work.'
/** A checkpoint's failing report when the files gate refused the build: its text is in the run directory. */
const FILES_GATE = 'files_gate'
const FILES_GATE_TEXT =
  "The build changed files the run does not allow. Check that you changed only the plan's files, undo the rest, and commit."
const PLAN_QUESTION =
  'The planner is not confident in this plan. Approve it, or say what to change.'

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
  const { worktree, runDir } = runPaths(deps.config.home, run.id)
  const steps = runSteps(work, deps, { worktree, runDir, budgetUsd: task.budget_usd })
  const { state } = steps
  /** A delivery run always carries its approved spec; one without it cannot go on. */
  const specOf = () => {
    if (run.spec === null) throw new End('failed', 'the run has no approved spec')
    return run.spec
  }
  /** A plan a Re-run copied into this run: no planner starts, and Build works from it. */
  const kept = run.kept_plan ?? null
  let testOutput: string | undefined
  let latestRun: RunView | undefined

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

  const uncommitted = async () =>
    (await deps.git.changedPaths(worktree, project.base_branch)).uncommitted

  const tests = async () => {
    // What the test command itself writes is the runner's doing, not the builder's.
    const before = await uncommitted()
    const result = await deps.runTests(project.test_command, worktree, {
      timeoutMs: deps.config.testTimeoutMs,
    })
    const made = newlyChanged(before, await uncommitted())
    writeExcluded(runDir, [...new Set([...readExcluded(runDir), ...made])])
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

  const handoffFor = (name: 'plan' | 'build' | 'verify') => async (): Promise<string> => {
    const common = {
      taskKey: task.key,
      title: task.title,
      specVersion: specOf().version,
      specMd: specOf().body_md,
      budgetUsd: task.budget_usd,
      phase: name,
      attempt: state.attempt,
      summaries: await summaries(),
      linked: linkedForHandoff(runDir),
    }
    if (name === 'plan')
      return buildHandoff({
        ...common,
        previousPlans: (run.previous_plans ?? []).map((p) => ({
          run: p.run,
          accepted: p.accepted,
          text: p.body_md,
        })),
        planAnswers: run.plan_answers ?? [],
      })
    const plan = state.planId === null ? undefined : await artifact('plan', { id: state.planId })
    if (plan === undefined) throw new End('failed', 'the run has no plan to work from')
    if (name === 'build') {
      const failing =
        state.failingId === null
          ? undefined
          : state.failingId === NO_COMMIT
            ? NO_COMMIT_TEXT
            : state.failingId === FILES_GATE
              ? gateReport()
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

  const gateReport = () => {
    const file = join(runDir, GATE_REPORT)
    return existsSync(file) ? readFileSync(file, 'utf8') : FILES_GATE_TEXT
  }

  /**
   * Whether the build changed only what the run allows. A violation writes the report and sends
   * the run back to Build (or ends it, on the last attempt); the test command does not run.
   */
  const gate = async (): Promise<boolean> => {
    const changed = await deps.git.changedPaths(worktree, project.base_branch)
    if (readAllowed(runDir) === null) await allowPlanFiles()
    const found = violationsOf({
      committed: changed.committed,
      uncommitted: changed.uncommitted,
      excluded: readExcluded(runDir),
      allowed: readAllowed(runDir) ?? [],
      approvedMigrations: readApproved(runDir),
    })
    if (found.length === 0) return true
    writeFileSync(join(runDir, GATE_REPORT), formatViolations(found, changed.mergeBase))
    if (state.attempt >= MAX_ATTEMPTS) {
      const names = found.map((v) => v.path).sort()
      const listed = names.slice(0, 20).join(', ')
      const more = names.length > 20 ? `, and ${names.length - 20} more` : ''
      throw new End(
        'failed',
        `the build changed files the run does not allow, on attempt ${state.attempt}: ${listed}${more}`,
      )
    }
    nextAttempt(FILES_GATE)
    return false
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
    writeApproved()
  }
  const writeApproved = () => {
    const approved = work.kind === 'resume' ? (work.approved_migrations ?? []) : []
    if (approved.length > 0) writeApprovedMigrations(runDir, approved)
  }

  return steps.carry({ repo: project.repo_path, branch }, async () => {
    if (run.kind !== 'delivery') throw new End('failed', 'a spec run is not a delivery run')
    prepareRunDir(runDir)
    writeBaseBranch(runDir, project.base_branch)
    if (work.kind === 'resume') {
      if (work.allowed_files.length > 0) writeAllowedFiles(runDir, work.allowed_files)
      writeApproved()
      if (state.stage !== 'prepare') {
        const there =
          existsSync(worktree) &&
          (await deps.git.currentBranch(worktree).catch(() => null)) === branch
        if (!there) throw new End('failed', "the run's worktree is gone")
      }
    }

    if (work.kind === 'resume' && state.stage !== 'prepare') await steps.restoreLinkedCheckouts()

    if (kept !== null) state.planId = kept.artifact_id

    for (;;) {
      await steps.stopIfShuttingDown()
      switch (state.stage) {
        case 'prepare': {
          await steps.checkpoint()
          if (work.kind === 'resume') {
            // A prepare that stopped partway may have left either half behind.
            await deps.git.removeWorktree(project.repo_path, worktree).catch(() => undefined)
            await deps.git.deleteBranch(project.repo_path, branch).catch(() => undefined)
          }
          await deps.git.prepareWorktree(project.repo_path, project.base_branch, branch, worktree)
          await steps.prepareLinkedCheckouts()
          await steps.runSetup(project.setup_command)
          // What setup left in the worktree is the runner's doing, not the builder's.
          writeExcluded(runDir, project.setup_command === null ? [] : await uncommitted())
          state.stage = kept === null ? 'plan' : 'build'
          if (kept !== null) await allowPlanFiles()
          state.attempt = 1
          break
        }
        case 'plan': {
          // Only a checkpoint from before the plan was copied lands here: Build, no planner.
          if (kept !== null) {
            await allowPlanFiles()
            state.stage = 'build'
            state.attempt = 1
            break
          }
          // A plan the owner approved at the gate: the phase ends, and Build starts (spec §5).
          if (state.phase !== null && state.message === null && work.kind === 'resume') {
            await steps.endPhase(true)
            await allowPlanFiles()
            state.stage = 'build'
            state.attempt = 1
            break
          }
          const result = await steps.phaseStep('plan', handoffFor('plan'))
          if (!result.ok) await steps.failPhase('plan')
          const plan = await artifact('plan', { phaseId: result.record.phaseId })
          if (plan === undefined) {
            await steps.endPhase(false)
            throw new End('failed', 'the planner saved no plan')
          }
          state.planId = plan.id
          if ((plan.data as PlanData).confidence !== 'high') {
            await steps.checkpoint()
            try {
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
            } catch (error) {
              // sink.send flushes older queued events first, so a 4xx on one of those reads as a
              // gate refusal too (AIDP-28).
              if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
                await steps.endPhase(false)
                throw new End('failed', gateRefusal(error))
              }
              throw error
            }
            throw new Release()
          }
          await steps.endPhase(true)
          await allowPlanFiles()
          state.stage = 'build'
          state.attempt = 1
          break
        }
        case 'build': {
          const result = await steps.phaseStep('build', handoffFor('build'))
          if (!result.ok) await steps.failPhase('build')
          await steps.endPhase(true)
          state.stage = 'tests'
          break
        }
        case 'tests': {
          await steps.checkpoint()
          if (!(await gate())) break
          const commits = await deps.git.newCommits(worktree, project.base_branch)
          await tests()
          await steps.stopIfShuttingDown()
          if (commits === 0) nextAttempt(NO_COMMIT)
          else state.stage = 'verify'
          break
        }
        case 'verify': {
          const result = await steps.phaseStep('verify', handoffFor('verify'))
          if (!result.ok) await steps.failPhase('verify')
          const report = await artifact('verify_report', { phaseId: result.record.phaseId })
          if (report === undefined) {
            await steps.endPhase(false)
            throw new End('failed', 'the verifier saved no report')
          }
          await steps.endPhase(true)
          if ((report.data as ReportData).criteria.every((c) => c.status !== 'fail'))
            state.stage = 'push'
          else nextAttempt(report.id)
          break
        }
        case 'push': {
          await steps.checkpoint()
          await deps.git.push(worktree, branch)
          state.stage = 'pr'
          break
        }
        case 'pr': {
          await steps.checkpoint()
          const report = (await getRun()).artifacts.filter((a) => a.kind === 'verify_report').at(-1)
          // A run stopped after `gh pr create` already has its pull request: it is taken.
          const pr =
            (await deps.git.findPr(worktree, { githubRepo: project.github_repo, branch })) ??
            (await deps.git.createPr(worktree, {
              githubRepo: project.github_repo,
              base: project.base_branch,
              branch,
              title: `${task.key}: ${task.title}`,
              body: `${task.key}, run ${run.number}, spec v${specOf().version}.\n\n## Verify report\n\n${report?.body_md ?? ''}\n`,
            }))
          return { outcome: 'review' as const, extra: { pr_number: pr.number, pr_url: pr.url } }
        }
        case 'spec':
          throw new End('failed', 'a spec run is not a delivery run')
      }
    }
  })
}

/**
 * A run cancelled while paused or blocked: its worktree goes; the board has already ended it.
 * The path is the runner's own convention, since the board learns a worktree's path only from a
 * run's end.
 */
export async function cleanUp(
  work: Extract<Work, { kind: 'cleanup' }>,
  deps: { git: Git; config: RunnerConfig },
): Promise<void> {
  const paths = runPaths(deps.config.home, work.run.id)
  await removeLinked(deps.git, paths.linked, paths.runDir).catch(() => undefined)
  const worktree = work.run.worktree_path ?? paths.worktree
  if (!existsSync(worktree)) return
  await deps.git.removeWorktree(work.run.repo_path, worktree).catch(() => undefined)
}

/** The reason a refused plan gate gives: a plain sentence, never the status line or the body. */
function gateRefusal(error: ApiError): string {
  const body = error.body as { details?: { findings?: unknown } } | undefined
  const findings = Array.isArray(body?.details?.findings) ? body.details.findings : []
  const named = findings
    .filter(
      (f): f is { field: string; code: string } =>
        typeof f?.field === 'string' && typeof f?.code === 'string',
    )
    .map((f) => `${f.field} is ${f.code.replaceAll('_', ' ')}`)
  return named.length === 0
    ? 'The board refused the plan gate.'
    : `The board refused the plan gate: ${named.join('; ')}.`
}
