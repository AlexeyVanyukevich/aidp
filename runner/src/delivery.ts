import { join } from 'node:path'
import type { BoardApi } from './api.js'
import type { PlanData, ReportData, Work } from './contract.js'
import type { RunnerConfig } from './config.js'
import { GitError, type Git } from './git.js'
import { buildHandoff, type HandoffInput } from './phases/handoff.js'
import type { PhaseDeps, PhaseInput, PhaseResult } from './phases/phase.js'
import { prepareRunDir, writePlanFiles } from './phases/run-dir.js'
import { newEvent, type EventSink } from './sink.js'
import type { runTestCommand } from './test-command.js'

export interface DeliveryDeps {
  api: BoardApi
  git: Git
  sink: EventSink
  setToken(token: string): void
  runPhase: (input: PhaseInput, deps: PhaseDeps) => Promise<PhaseResult>
  runTests: typeof runTestCommand
  config: RunnerConfig
  signal: AbortSignal
}

type Outcome = 'review' | 'failed' | 'cancelled'
const MAX_ATTEMPTS = 3

/** Thrown inside the run to end it; caught once, at the bottom. */
class End extends Error {
  constructor(
    readonly outcome: Outcome,
    readonly reason: string | null,
  ) {
    super(reason ?? outcome)
  }
}

export async function runDelivery(work: Work, deps: DeliveryDeps): Promise<Outcome> {
  const { run } = work
  const { project, task } = run
  const branch = `board/${task.key}-r${run.number}`
  const worktree = join(deps.config.home, 'worktrees', run.id)
  const runDir = join(deps.config.home, 'runs', run.id)
  const common = {
    taskKey: task.key,
    title: task.title,
    specVersion: run.spec.version,
    specMd: run.spec.body_md,
    budgetUsd: task.budget_usd,
  }
  const summaries: HandoffInput['summaries'] = []
  let worktreeReady = false

  const phase = async (
    name: 'plan' | 'build' | 'verify',
    attempt: number,
    extra: Partial<HandoffInput>,
  ): Promise<PhaseResult> => {
    const result = await deps.runPhase(
      {
        runId: run.id,
        phase: name,
        attempt,
        handoff: buildHandoff({
          ...common,
          phase: name,
          attempt,
          summaries: [...summaries],
          ...extra,
        }),
        worktree,
        runDir,
        budgetUsd: task.budget_usd,
      },
      {
        api: deps.api,
        sink: deps.sink,
        claudeBin: deps.config.claudeBin,
        boardUrl: deps.config.boardUrl,
        signal: deps.signal,
        setToken: deps.setToken,
      },
    )
    if (result.cancelled) throw new End('cancelled', 'cancelled by the owner')
    if (!result.ok)
      throw new End(
        'failed',
        attempt === 1 && name !== 'build'
          ? `the ${name} phase failed`
          : `the ${name} phase failed on attempt ${attempt}`,
      )
    summaries.push({ phase: name, attempt, text: result.summary })
    return result
  }

  const artifact = async (kind: 'plan' | 'verify_report', phaseId: string) =>
    (await deps.api.getRun(run.id)).artifacts.find((a) => a.kind === kind && a.phase_id === phaseId)

  let outcome: Outcome = 'failed'
  let extra: Record<string, unknown> = {}
  try {
    deps.setToken(await deps.api.issueToken(run.id))
    if (run.kind !== 'delivery') throw new End('failed', 'spec runs arrive in slice 3')
    prepareRunDir(runDir)
    await deps.git.prepareWorktree(project.repo_path, project.base_branch, branch, worktree)
    worktreeReady = true

    const planned = await phase('plan', 1, {})
    const planArtifact = await artifact('plan', planned.phaseId)
    if (planArtifact === undefined) throw new End('failed', 'the planner saved no plan')
    const plan = planArtifact.data as PlanData
    writePlanFiles(runDir, [...new Set(plan.steps.flatMap((step) => step.files))])

    let failingReport: string | undefined
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await phase('build', attempt, {
        plan: planArtifact.body_md,
        ...(failingReport === undefined ? {} : { verifyReport: failingReport }),
      })
      const commits = await deps.git.newCommits(worktree, project.base_branch)
      const tests = await deps.runTests(project.test_command, worktree, {
        timeoutMs: deps.config.testTimeoutMs,
      })
      await deps.sink.send([
        newEvent(
          { runId: run.id, phaseId: null, type: 'tool_call', agent: 'runner' },
          {
            tool: 'test_command',
            target: project.test_command,
            status: tests.exitCode === 0 ? 'ok' : 'error',
            duration_ms: tests.durationMs,
            payload: {
              exit_code: tests.exitCode,
              timed_out: tests.timedOut,
              truncated: tests.truncated,
              output_tail: tests.output.slice(-4_096),
            },
          },
        ),
      ])
      if (commits === 0) {
        failingReport =
          'The build made no commit, so there was nothing to verify. Commit your work.'
        continue
      }

      const verified = await phase('verify', attempt, {
        plan: planArtifact.body_md,
        testOutput: `exit code: ${tests.timedOut ? 'killed after timeout' : String(tests.exitCode)}\n${tests.truncated ? '[output cut to its end]\n' : ''}${tests.output}`,
        diff: await deps.git.diff(worktree, project.base_branch),
      })
      const reportArtifact = await artifact('verify_report', verified.phaseId)
      if (reportArtifact === undefined) throw new End('failed', 'the verifier saved no report')
      const report = reportArtifact.data as ReportData
      if (report.criteria.every((criterion) => criterion.status === 'pass')) {
        await deps.git.push(worktree, branch)
        const pr = await deps.git.createPr(worktree, {
          githubRepo: project.github_repo,
          base: project.base_branch,
          branch,
          title: `${task.key}: ${task.title}`,
          body: `${task.key}, run ${run.number}, spec v${run.spec.version}.\n\n## Verify report\n\n${reportArtifact.body_md}\n`,
        })
        outcome = 'review'
        extra = { pr_number: pr.number, pr_url: pr.url }
        return outcome
      }
      failingReport = reportArtifact.body_md
    }
    throw new End('failed', 'verify failed three times')
  } catch (error) {
    if (error instanceof End) {
      outcome = error.outcome
      extra = { reason: error.reason }
    } else if (error instanceof GitError) {
      extra = { reason: error.message }
    } else {
      extra = { reason: error instanceof Error ? error.message : String(error) }
    }
    return outcome
  } finally {
    if (worktreeReady)
      await deps.git.removeWorktree(project.repo_path, worktree).catch(() => undefined)
    await deps.sink.send([
      newEvent(
        { runId: run.id, phaseId: null, type: 'run_end' },
        { payload: { outcome, branch, worktree_path: worktree, ...extra } },
      ),
    ])
  }
}
