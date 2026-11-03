import { existsSync } from 'node:fs'
import type { Work } from './contract.js'
import { buildHandoff } from './phases/handoff.js'
import { linkedForHandoff } from './linked.js'
import { clearPendingAnswer, prepareRunDir } from './phases/run-dir.js'
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
      linked: linkedForHandoff(runDir),
      base: { branch: project.base_branch, commit: await deps.git.head(worktree) },
    })

  return steps.carry({ repo: project.repo_path, branch: null }, async () => {
    if (run.kind !== 'spec') throw new End('failed', 'a delivery run is not a spec run')
    prepareRunDir(runDir)
    // A resumed run whose worktree is gone gets a detached one of the base again; the refresh
    // below runs setup and the linked checkouts.
    if (work.kind === 'resume' && state.stage !== 'prepare' && !existsSync(worktree))
      await steps.recreate({
        caller: 'draft_resume',
        repo: project.repo_path,
        branch: null,
        add: () =>
          deps.git.prepareDetachedWorktree(project.repo_path, project.base_branch, worktree),
      })

    // A resume at the spec stage refreshes the run once, before any process starts.
    let refresh = work.kind === 'resume' && state.stage === 'spec'

    for (;;) {
      await steps.stopIfShuttingDown()
      switch (state.stage) {
        case 'prepare': {
          await steps.checkpoint()
          // A prepare that stopped partway may have left its worktree behind.
          if (work.kind === 'resume')
            await steps.removeWorktree('draft_prepare', project.repo_path, worktree)
          await deps.git.prepareDetachedWorktree(project.repo_path, project.base_branch, worktree)
          await steps.prepareLinkedCheckouts()
          await steps.runSetup(project.setup_command)
          state.stage = 'spec'
          state.attempt = 1
          break
        }
        case 'spec': {
          let note: string | null = null
          let answered = false
          if (refresh) {
            refresh = false
            const kept = steps.keepWords()
            answered = kept.answered
            note = await steps.refreshBase(
              'spec',
              project.repo_path,
              project.base_branch,
              project.setup_command,
            )
            if (kept.replaced) await steps.savedAnswerSent(false)
          }
          const result = await steps.phaseStep('spec', handoff, {
            note,
            delivered: () => {
              if (answered) clearPendingAnswer(runDir)
            },
          })
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
