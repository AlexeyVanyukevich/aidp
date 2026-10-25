import { existsSync } from 'node:fs'
import type { Work } from './contract.js'
import { buildHandoff } from './phases/handoff.js'
import { prepareRunDir } from './phases/run-dir.js'
import { End, runPaths, runSteps, type RunDeps } from './run-steps.js'

/**
 * Carries a spec run out (slice 3 spec, §5): a detached worktree of the base, then one Spec
 * phase, resumable like any other, whose spec-writer saves its draft through the board. The run
 * ends `drafted` when the phase succeeds; the board checks it saved a version.
 */
export async function draftSpec(
  work: Extract<Work, { kind: 'start' | 'resume' }>,
  deps: RunDeps,
): Promise<'drafted' | 'failed' | 'cancelled' | 'released'> {
  const { run } = work
  const { project, task } = run
  const { worktree, runDir } = runPaths(deps.config.home, run.id)
  const steps = runSteps(work, deps, { worktree, runDir, budgetUsd: task.budget_usd })
  const { state } = steps

  const handoff = async () =>
    buildHandoff({
      taskKey: task.key,
      title: task.title,
      phase: 'spec',
      attempt: state.attempt,
      description: task.description_md,
      ...(run.spec === null ? {} : { specVersion: run.spec.version, specMd: run.spec.body_md }),
      ...(run.note === null ? {} : { note: run.note }),
      budgetUsd: task.budget_usd,
      summaries: [],
    })

  return steps.carry({ repo: project.repo_path, branch: null }, async () => {
    if (run.kind !== 'spec') throw new End('failed', 'a delivery run is not a spec run')
    prepareRunDir(runDir)
    if (work.kind === 'resume' && state.stage !== 'prepare' && !existsSync(worktree))
      throw new End('failed', "the run's worktree is gone")

    for (;;) {
      await steps.stopIfShuttingDown()
      switch (state.stage) {
        case 'prepare': {
          await steps.checkpoint()
          // A prepare that stopped partway may have left its worktree behind.
          if (work.kind === 'resume')
            await deps.git.removeWorktree(project.repo_path, worktree).catch(() => undefined)
          await deps.git.prepareDetachedWorktree(project.repo_path, project.base_branch, worktree)
          state.stage = 'spec'
          state.attempt = 1
          break
        }
        case 'spec': {
          const result = await steps.phaseStep('spec', handoff)
          if (!result.ok) await steps.failPhase('spec')
          await steps.endPhase(true)
          return { outcome: 'drafted' as const, extra: {} }
        }
        default:
          throw new End('failed', `a spec run has no ${state.stage} stage`)
      }
    }
  })
}
