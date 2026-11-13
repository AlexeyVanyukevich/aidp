import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlanData, ReportData, RunView, Work } from './contract.js'
import type { RunnerConfig } from './config.js'
import type { Git } from './git.js'
import { buildHandoff, type HandoffInput } from './phases/handoff.js'
import { formatViolations, newlyChanged, readApprovedCopies, violationsOf } from './files-gate.js'
import {
  BASE_CONFLICT_REPORT,
  GATE_HEAD,
  GATE_REPORT,
  TEST_COMMAND_REPORT,
  type ApprovedMigration,
  clearMark,
  clearPendingAnswer,
  clearUntested,
  isApprovedList,
  prepareRunDir,
  readAllowed,
  readApproved,
  readExcluded,
  readUndone,
  clearUndone,
  readMark,
  readPendingAnswer,
  readUntested,
  writeAllowedFiles,
  writeApprovedMigrations,
  writeBaseBranch,
  writeExcluded,
  writeMark,
  writePendingAnswer,
  writeUntested,
} from './phases/run-dir.js'
import {
  End,
  INTERRUPTED,
  Release,
  runPaths,
  runSteps,
  type Outcome,
  type RunDeps,
} from './run-steps.js'
import { ApiError } from './api.js'
import { linkedForHandoff, removeLinked } from './linked.js'
import { newEvent } from './sink.js'
import { removeCheckout, type LogContext } from './worktree-log.js'
import {
  classifyTestRun,
  failedBlockOutput,
  fixInstruction,
  notPassedBlockOutput,
  testCommandReport,
  testCommandReportFallback,
  unchangedBlockOutput,
  type runTestCommand,
  type TestRun,
} from './test-command.js'

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
/** A checkpoint's failing report when the branch did not rebase onto the base: its text is in the run directory. */
const BASE_CONFLICT = 'base_conflict'
const BASE_CONFLICT_TEXT =
  'The branch conflicts with the base branch. Run `git rebase origin/<base>`, resolve each conflicting path, `git add` it and `git rebase --continue` until the rebase is done.'
/** A checkpoint's failing report when the test command failed: its text is in the run directory. */
const TEST_COMMAND = 'test_command'
/** Leaves a Verify handoff that ran the test command and found it did not pass. */
class TestsNotPassed extends Error {
  constructor(readonly result: TestRun) {
    super('the test command did not pass')
  }
}
const NOTE_PATHS = 100
const PR_UNTESTED = 20
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
      .filter((p) => p.name !== 'help' && p.status === 'succeeded' && p.summary_md !== null)
      .map((p) => ({ phase: p.name, attempt: p.attempt, text: p.summary_md ?? '' }))

  const uncommitted = async () =>
    (await deps.git.changedPaths(worktree, project.base_branch)).uncommitted

  const tests = async () => {
    // The test command judges only committed work: the builder's leftovers go first.
    await steps.undoUncommitted(project.base_branch, 'builders')
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
    const text = `exit code: ${result.timedOut ? 'killed after timeout' : String(result.exitCode)}\n${result.truncated ? '[output cut to its end]\n' : ''}${result.output}`
    testOutput = text
    return result
  }

  const fix = () =>
    fixInstruction({ worktree, command: project.test_command, base: project.base_branch })

  /**
   * Acts on a run of the test command: true when it passed. A failure on attempt 1 or 2 writes
   * the report and sends the run back to Build; the rest block the run at the tests stage.
   */
  const actOnTests = async (result: TestRun): Promise<boolean> => {
    const verdict = classifyTestRun(result)
    if (verdict === 'passed') return true
    state.stage = 'tests'
    const command = project.test_command
    if (verdict === 'failed' && state.attempt < MAX_ATTEMPTS) {
      writeFileSync(join(runDir, TEST_COMMAND_REPORT), testCommandReport(command, result))
      nextAttempt(TEST_COMMAND)
      return false
    }
    const output =
      verdict === 'failed' ? failedBlockOutput(result, fix()) : notPassedBlockOutput(result, fix())
    return steps.block('step_failed', { command, output })
  }

  const testCommandText = () => {
    const file = join(runDir, TEST_COMMAND_REPORT)
    return existsSync(file)
      ? readFileSync(file, 'utf8')
      : testCommandReportFallback(project.test_command)
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
        // The planner's resume message already carries the run's own answers.
        planAnswers: (run.plan_answers ?? []).filter((a) => a.run !== run.number),
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
              : state.failingId === BASE_CONFLICT
                ? conflictReport()
                : state.failingId === TEST_COMMAND
                  ? testCommandText()
                  : (await artifact('verify_report', { id: state.failingId }))?.body_md
      const undone = readUndone(runDir)
      const report =
        failing === undefined || state.failingId === NO_COMMIT || undone.length === 0
          ? failing
          : `${failing}\n\nThe runner undid these paths the build left uncommitted:\n${undone.join('\n')}\nOnly committed work is tested, shown in the diff and pushed.`
      return buildHandoff({
        ...common,
        plan: plan.body_md,
        approvedMigrations: readApproved(runDir),
        ...(report === undefined ? {} : { verifyReport: report }),
      })
    }
    // A Verify started afresh after a resume has no test output yet: the tests run again.
    if (testOutput === undefined) {
      const result = await tests()
      if (classifyTestRun(result) !== 'passed') {
        // The verifier does not start: its phase is dropped, or ended when the board knows it.
        state.stage = 'tests'
        const recorded =
          work.kind === 'resume' &&
          state.phase !== null &&
          work.checkpoint.phase_id === state.phase.phaseId
        if (recorded) await steps.endPhase(false)
        else state.phase = null
        throw new TestsNotPassed(result)
      }
    }
    const moved = await verifyNote()
    const undone = readUndone(runDir)
    const undoneNote =
      undone.length === 0
        ? undefined
        : `Before the test command ran, the runner undid these paths the build left uncommitted:\n${undone.join('\n')}\nOnly committed work is tested, shown in the diff and pushed.`
    const note = [moved, undoneNote].filter((n) => n !== undefined).join('\n\n')
    return buildHandoff({
      ...common,
      ...(note === '' ? {} : { note }),
      plan: plan.body_md,
      testOutput: testOutput ?? '',
      diff: await deps.git.diff(worktree, project.base_branch),
      planAnswers: run.plan_answers ?? [],
    })
  }

  const conflictReport = () => {
    const file = join(runDir, BASE_CONFLICT_REPORT)
    return existsSync(file)
      ? readFileSync(file, 'utf8')
      : BASE_CONFLICT_TEXT.replaceAll('<base>', project.base_branch)
  }

  /**
   * The verifier's note when the base moved since Build began, or since the last Verify. Reading
   * it moves the reference: the next Verify is told only what is new.
   */
  const verifyNote = async (): Promise<string | undefined> => {
    const tested = readMark(runDir, 'tested')
    const last = readMark(runDir, 'verify')
    const reference = last ?? readMark(runDir, 'build')
    if (tested === null || reference === null) return undefined
    writeMark(runDir, 'verify', tested)
    if (tested === reference) return undefined
    const paths = await deps.git.changedBetween(worktree, reference, tested)
    const commits = await deps.git.commitCount(worktree, reference, tested)
    const listed = paths.slice(0, NOTE_PATHS)
    const more = paths.length - listed.length
    return [
      `The base branch moved since ${last === null ? 'Build began' : 'the last Verify'}. It was at ${reference}; the branch is now tested on ${tested}, ${commits} commits later.`,
      'Paths changed between them:',
      ...listed,
      ...(more > 0 ? [`and ${more} more`] : []),
      'Check that the change still meets the spec with these changes to the base in place.',
    ].join('\n')
  }

  /**
   * A rebase onto the base that did not go through, found at the start of the tests stage or made
   * by the runner: the branch is put back as it was, the worktree and the setup record are reset,
   * and the next Build is told which paths conflict. On the last attempt the run is blocked.
   */
  const baseConflict = async (onto: string, paths: string[], aborted: boolean): Promise<void> => {
    const base = project.base_branch
    if (!aborted) await deps.git.rebaseAbort(worktree)
    await steps.runnerEvent({
      tool: 'base_rebase',
      target: `${paths.length} paths conflict with the base`,
      status: 'error',
      payload: { to: onto, conflicts: paths },
    })
    await steps.undoUncommitted(base)
    writeExcluded(runDir, [])
    clearMark(runDir, 'setup')
    const command = `git rebase origin/${base}`
    const report = [
      `The branch conflicts with ${base}. The rebase was onto ${onto}; these paths conflict:`,
      '',
      ...paths.map((p) => `- ${p}`),
      '',
      `Run \`${command}\`, resolve each path, \`git add\` it and \`git rebase --continue\` until the rebase is done.`,
      '',
    ].join('\n')
    writeFileSync(join(runDir, BASE_CONFLICT_REPORT), report)
    if (state.attempt >= MAX_ATTEMPTS)
      await steps.block('step_failed', {
        command,
        output: [
          ...paths,
          `In ${worktree}, run \`${command}\`, resolve each path listed, \`git add\` it and run \`git rebase --continue\` until the rebase is done, then Resume.`,
        ].join('\n'),
      })
    nextAttempt(BASE_CONFLICT)
  }

  /** The pull request body's lines about the base: what was tested, and what arrived too late. */
  const testedSection = (): string => {
    const tested = readMark(runDir, 'tested')
    if (tested === null) return ''
    const untested = readUntested(runDir)
    const listed = untested.slice(0, PR_UNTESTED).map((c) => `${c.sha} ${c.subject}`)
    const more = untested.length - listed.length
    const section =
      untested.length === 0
        ? ''
        : `## Not tested with this change\n\n${[...listed, ...(more > 0 ? [`and ${more} more`] : [])].join('\n')}\n\n`
    return `Tested on \`${project.base_branch}\` at \`${tested}\`.\n\n${section}`
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
    const approved = readApproved(runDir)
    const copies = await readApprovedCopies(
      approved,
      [...changed.committed, ...changed.uncommitted],
      (path) => {
        try {
          return readFileSync(join(worktree, path), 'utf8')
        } catch {
          return null
        }
      },
      (path) => deps.git.fileAtHead(worktree, path),
    )
    const found = violationsOf({
      committed: changed.committed,
      uncommitted: changed.uncommitted,
      excluded: readExcluded(runDir),
      allowed: readAllowed(runDir) ?? [],
      approvedMigrations: approved,
      ...copies,
    })
    await deps.sink.send([
      newEvent(
        { runId: run.id, phaseId: null, type: 'tool_call', agent: 'runner' },
        {
          tool: 'files_gate',
          target:
            found.length === 0
              ? 'every changed path is allowed'
              : `${found.length} ${found.length === 1 ? 'path' : 'paths'} the run does not allow`,
          status: found.length === 0 ? 'ok' : 'error',
          payload: { violations: found },
        },
      ),
    ])
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
  let approvedClaim: ApprovedMigration[] = []
  const writeApproved = () => {
    if (approvedClaim.length > 0) writeApprovedMigrations(runDir, approvedClaim)
  }

  return steps.carry({ repo: project.repo_path, branch }, async () => {
    if (run.kind !== 'delivery') throw new End('failed', 'a spec run is not a delivery run')
    // A claim in the old form (plain strings) would allow a path without a content check.
    const claimed = work.kind === 'resume' ? (work.approved_migrations ?? []) : []
    if (!isApprovedList(claimed))
      throw new End(
        'failed',
        'the claim’s approved_migrations is not a list of { path, content } entries; the board and the runner are out of step',
      )
    approvedClaim = claimed
    prepareRunDir(runDir)
    writeBaseBranch(runDir, project.base_branch)
    if (work.kind === 'resume') {
      if (work.allowed_files.length > 0) writeAllowedFiles(runDir, work.allowed_files)
      writeApproved()
    }

    // A Plan-stage resume refreshes the base instead (and remakes the links there).
    const refreshAtPlan =
      work.kind === 'resume' && work.checkpoint.stage === 'plan' && kept === null
    let refreshed = false

    if (work.kind === 'resume' && state.stage !== 'prepare') {
      if (!existsSync(worktree)) {
        // The refresh at Plan runs setup itself; any other stage runs it here.
        await steps.recreate({
          caller: 'delivery_resume',
          repo: project.repo_path,
          branch,
          add: () => deps.git.addWorktreeOnBranch(project.repo_path, branch, worktree),
          ...(refreshAtPlan
            ? {}
            : {
                setup: {
                  command: project.setup_command,
                  base: project.base_branch,
                  after: async () =>
                    writeExcluded(
                      runDir,
                      project.setup_command === null ? [] : await uncommitted(),
                    ),
                },
              }),
        })
      } else if ((await deps.git.currentBranch(worktree).catch(() => null)) !== branch) {
        // A rebase of the run's branch in progress has HEAD detached: that is not a lost worktree.
        const half = await deps.git.rebaseInProgress(worktree, branch).catch(() => null)
        if (half === null) throw new End('failed', "the run's worktree is gone")
        // Build continues with the rebase in place, and the tests stage handles it (R4).
        if (state.stage !== 'build' && state.stage !== 'tests')
          await steps.block('step_failed', {
            command: 'git rebase',
            output: `A rebase of ${branch} is in progress in ${worktree}. Abort it with \`git rebase --abort\`, then Resume.`,
          })
      }
      if (!refreshAtPlan) await steps.restoreLinkedCheckouts()
    }

    if (kept !== null) state.planId = kept.artifact_id

    for (;;) {
      await steps.stopIfShuttingDown()
      switch (state.stage) {
        case 'prepare': {
          await steps.checkpoint()
          if (work.kind === 'resume') {
            // A prepare that stopped partway may have left either half behind.
            await steps.removeWorktree('delivery_prepare', project.repo_path, worktree)
            await deps.git.deleteBranch(project.repo_path, branch).catch(() => undefined)
          }
          await deps.git.prepareWorktree(project.repo_path, project.base_branch, branch, worktree)
          await steps.prepareLinkedCheckouts()
          await steps.runSetup(project.setup_command, undefined, project.base_branch)
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
          let note: string | null = null
          let answered = false
          if (refreshAtPlan && !refreshed) {
            refreshed = true
            const saved = readPendingAnswer(runDir)
            const nudge = state.message === INTERRUPTED
            const replaced = nudge && saved !== null
            if (replaced) state.message = saved.kind === 'words' ? saved.text : null
            const approve = state.phase !== null && state.message === null
            if (approve) writePendingAnswer(runDir, { kind: 'approved' })
            else if (state.message !== null && !nudge) {
              writePendingAnswer(runDir, { kind: 'words', text: state.message })
            }
            answered = approve || (state.message !== null && (!nudge || replaced))
            note = await steps.refreshBase(
              'plan',
              project.repo_path,
              project.base_branch,
              project.setup_command,
            )
            if (replaced) await steps.savedAnswerSent(approve)
            // A plan the owner approved at the gate: the phase ends, and Build starts (spec §5).
            if (approve) {
              await steps.endPhase(true)
              await allowPlanFiles()
              state.stage = 'build'
              state.attempt = 1
              await steps.checkpoint()
              clearPendingAnswer(runDir)
              break
            }
          }
          const result = await steps.phaseStep('plan', handoffFor('plan'), {
            note,
            delivered: () => {
              if (answered) clearPendingAnswer(runDir)
            },
          })
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
          if (state.attempt === 1 && readMark(runDir, 'build') === null)
            writeMark(runDir, 'build', await deps.git.mergeBase(worktree, project.base_branch))
          const result = await steps.phaseStep('build', handoffFor('build'))
          if (!result.ok) await steps.failPhase('build')
          await steps.endPhase(true)
          state.stage = 'tests'
          // A Build that fixed nothing is not tested again: the same failure would come back.
          const gateHead = join(runDir, GATE_HEAD)
          if (
            state.failingId === TEST_COMMAND &&
            existsSync(gateHead) &&
            (await deps.git.head(worktree)) === readFileSync(gateHead, 'utf8').trim()
          )
            await steps.block('step_failed', {
              command: project.test_command,
              output: unchangedBlockOutput(fix()),
            })
          break
        }
        case 'tests': {
          clearUndone(runDir)
          await steps.checkpoint()
          const base = project.base_branch
          // A rebase left in progress is a conflict: the builder's, or one a resume found.
          const half = await deps.git.rebaseInProgress(worktree, branch)
          if (half !== null) {
            const paths = await deps.git.unmergedPaths(worktree)
            await deps.git.rebaseAbort(worktree)
            await baseConflict(half.onto, paths, true)
            break
          }
          await deps.git.fetchBase(project.repo_path, base)
          if ((await deps.git.newCommits(worktree, base)) === 0) {
            // Nothing to test: no undo, setup, rebase or test command; the builder's edits stay.
            if (!(await gate())) break
            await steps.stopIfShuttingDown()
            nextAttempt(NO_COMMIT)
            break
          }
          const rebaseOwed = !(await deps.git.baseIsAncestor(worktree, base))
          if (await steps.setupOwed(project.setup_command, base)) {
            await steps.undoUncommitted(base)
            if (!rebaseOwed) {
              await steps.runSetup(project.setup_command, undefined, base)
              writeExcluded(runDir, await uncommitted())
            }
          }
          if (!(await gate())) break
          if (rebaseOwed) {
            await steps.undoUncommitted(base)
            const from = await deps.git.mergeBase(worktree, base)
            const to = await deps.git.revParse(worktree, `origin/${base}`)
            const { conflicts } = await deps.git.rebase(worktree, base)
            if (conflicts.length > 0) {
              await baseConflict(to, conflicts, false)
              break
            }
            const commits = await deps.git.commitCount(worktree, from, to)
            await steps.runnerEvent({
              tool: 'base_rebase',
              target: `rebased onto ${to}, ${commits} commits later`,
              status: 'ok',
              payload: {
                from,
                to,
                commits,
                paths: await deps.git.changedBetween(worktree, from, to),
              },
            })
            await steps.runSetup(project.setup_command, undefined, base)
            writeExcluded(runDir, project.setup_command === null ? [] : await uncommitted())
          }
          // Verify may not move the branch that is pushed: the push stage compares against this.
          writeFileSync(join(runDir, GATE_HEAD), await deps.git.head(worktree))
          writeMark(runDir, 'tested', await deps.git.revParse(worktree, `origin/${base}`))
          const ran = await tests()
          await steps.stopIfShuttingDown()
          if (await actOnTests(ran)) state.stage = 'verify'
          break
        }
        case 'verify': {
          let result
          try {
            result = await steps.phaseStep('verify', handoffFor('verify'))
          } catch (error) {
            if (!(error instanceof TestsNotPassed)) throw error
            await steps.stopIfShuttingDown()
            await actOnTests(error.result)
            break
          }
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
          // Absent only for a run started before the gate existed.
          const gateHead = join(runDir, GATE_HEAD)
          if (existsSync(gateHead)) {
            const built = readFileSync(gateHead, 'utf8').trim()
            const now = await deps.git.head(worktree)
            if (now !== built)
              throw new End(
                'failed',
                `Verify changed the branch: HEAD is ${now}, Build ended on ${built}`,
              )
          }
          // A base commit that arrived after the tests is recorded, never a reason to stop.
          const tested = readMark(runDir, 'tested')
          if (tested !== null) {
            const base = project.base_branch
            await deps.git.fetchBase(project.repo_path, base)
            const now = await deps.git.revParse(worktree, `origin/${base}`)
            if (now === tested) clearUntested(runDir)
            else {
              const commits = await deps.git.logRange(worktree, tested, `origin/${base}`)
              writeUntested(runDir, commits)
              await steps.runnerEvent({
                tool: 'base_check',
                target: `${commits.length} commits reached ${base} after the tests`,
                status: 'error',
                payload: { tested, now, commits },
              })
            }
          }
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
              body: `${task.key}, run ${run.number}, spec v${specOf().version}.\n\n${testedSection()}## Verify report\n\n${report?.body_md ?? ''}\n`,
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
  deps: { git: Git; config: RunnerConfig; clock?: () => Date },
): Promise<void> {
  const paths = runPaths(deps.config.home, work.run.id)
  // No token here, so the removals are logged and not sent to the board.
  const ctx: LogContext = {
    home: deps.config.home,
    runId: work.run.id,
    clock: deps.clock ?? (() => new Date()),
  }
  await removeLinked(deps.git, paths.linked, paths.runDir, ctx, 'cleanup').catch(() => undefined)
  const worktree = work.run.worktree_path ?? paths.worktree
  await removeCheckout(ctx, deps.git, work.run.repo_path, 'cleanup', worktree)
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
