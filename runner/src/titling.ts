import type { Work } from './contract.js'
import { buildHandoff } from './phases/handoff.js'
import { prepareRunDir } from './phases/run-dir.js'
import { End, runPaths, runSteps, type RunDeps } from './run-steps.js'

/**
 * Carries a title run out: a detached worktree of the base, then one read-only Title phase whose
 * agent suggests a title through the board. The run ends `suggested` when the phase succeeds (the
 * board checks it stored one) and never pauses, blocks or resumes; the card never moves.
 */
export async function suggestTitle(
  work: Extract<Work, { kind: 'start' }>,
  deps: RunDeps,
): Promise<'suggested' | 'failed' | 'cancelled' | 'released'> {
  const { run } = work
  const { project, task } = run
  const { worktree, runDir } = runPaths(deps.config.home, run.id)
  const steps = runSteps(work, deps, { worktree, runDir, budgetUsd: null })

  const handoff = async () =>
    buildHandoff({
      taskKey: task.key,
      title: task.title,
      phase: 'title',
      attempt: 1,
      ...(task.description_md.trim() === '' ? {} : { description: task.description_md }),
      budgetUsd: null,
      summaries: [],
    })

  return steps.carry({ repo: project.repo_path, branch: null }, async () => {
    if (run.kind !== 'title') throw new End('failed', 'only a title run is carried out here')
    prepareRunDir(runDir)
    await steps.stopIfShuttingDown()
    await deps.git.prepareDetachedWorktree(project.repo_path, project.base_branch, worktree)
    const result = await steps.phaseStep('title', handoff)
    if (!result.ok) await steps.failPhase('title')
    await steps.endPhase(true)
    return { outcome: 'suggested' as const, extra: {} }
  })
}
