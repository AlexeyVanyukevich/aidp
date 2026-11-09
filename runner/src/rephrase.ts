import type { Work } from './contract.js'
import { linkedForHandoff } from './linked.js'
import { buildHandoff } from './phases/handoff.js'
import { prepareRunDir } from './phases/run-dir.js'
import { End, runPaths, runSteps, type RunDeps } from './run-steps.js'

/**
 * Carries a rephrase run out: a detached worktree of the base with the linked checkouts and no
 * setup, then one read-only Rephrase phase whose agent saves a suggested description through the
 * board. The run ends `suggested` when the phase succeeds (the board checks it saved one) and
 * never pauses, blocks or resumes; it creates no branch, pushes nothing, and the card never moves.
 */
export async function rephraseDescription(
  work: Extract<Work, { kind: 'start' }>,
  deps: RunDeps,
): Promise<'suggested' | 'failed' | 'cancelled' | 'released'> {
  const { run } = work
  const { project, task } = run
  const { worktree, runDir } = runPaths(deps.config.home, run.id)
  const steps = runSteps(work, deps, { worktree, runDir, budgetUsd: task.budget_usd })
  const { state } = steps

  const handoff = async () =>
    buildHandoff({
      taskKey: task.key,
      title: task.title,
      phase: 'rephrase',
      attempt: 1,
      description: run.base_md ?? task.description_md,
      budgetUsd: task.budget_usd,
      summaries: [],
      linked: linkedForHandoff(runDir),
    })

  return steps.carry({ repo: project.repo_path, branch: null }, async () => {
    if (run.kind !== 'rephrase') throw new End('failed', 'only a rephrase run is carried out here')
    prepareRunDir(runDir)
    await steps.stopIfShuttingDown()
    state.stage = 'prepare'
    await deps.git.prepareDetachedWorktree(project.repo_path, project.base_branch, worktree)
    await steps.prepareLinkedCheckouts()
    state.stage = 'rephrase'
    state.attempt = 1
    const result = await steps.phaseStep('rephrase', handoff)
    if (!result.ok) await steps.failPhase('rephrase')
    await steps.endPhase(true)
    return { outcome: 'suggested' as const, extra: {} }
  })
}
