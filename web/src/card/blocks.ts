import { LABELS } from '../board/columns'
import type { Block, Stage, TaskState, TaskView } from '../types'

const DURING: Record<Stage, string> = {
  prepare: 'during preparation',
  spec: 'during the draft',
  plan: 'during Plan',
  build: 'during Build',
  tests: 'during the tests',
  verify: 'during Verify',
  push: 'during the push',
  pr: 'while opening the pull request',
}

/** Why a card is blocked, in the words of the slice 2 spec's §8. */
export function blockText(block: Block): string {
  if (block.cause === 'runner_lost') return 'The runner stopped sending heartbeats.'
  if (block.cause === 'step_failed')
    return `This step failed: ${block.command ?? 'a git or gh command'}`
  if (block.cause === 'runner_stopped')
    return `The runner was stopped ${block.stage === null ? 'mid-run' : DURING[block.stage]}.`
  return 'The question went unanswered for 48 hours. Answer it in Approvals.'
}

/** The state line's actions a card offers besides Move up and Move down. */
export function actionsFor(
  state: TaskState,
  block: Block | null,
  planToKeep: TaskView['plan_to_keep'] = null,
): { markDone: boolean; resume: boolean; cancel: boolean; rerun: boolean; rerunKeep: boolean } {
  return {
    markDone: state === 'review',
    // An expired question is answered in Approvals, not resumed past (spec §2).
    resume: state === 'blocked' && block?.cause !== 'approval_expired',
    cancel: ['spec_draft', 'ready', 'running', 'needs_approval', 'blocked'].includes(state),
    // "Re-run and plan again" is always there on a Failed card; keeping needs a plan to keep.
    rerun: state === 'failed',
    rerunKeep: state === 'failed' && planToKeep !== null,
  }
}

/** A card waiting on a question opens on it. */
export function initialTab(task: Pick<TaskView, 'state' | 'block'>): string {
  return task.state === 'needs_approval' ||
    (task.state === 'blocked' && task.block?.cause === 'approval_expired')
    ? 'approvals'
    : 'spec'
}

/**
 * What the card announces when its state changes, whoever changed it: the new state, then what
 * the move means — a question waiting, a draft ready to review, or why a draft did not finish.
 */
export function stateAnnouncement(change: {
  key: string
  from: TaskState
  to: TaskState
  /** The task's newest spec version, read after the move. */
  latestVersion: number | null
  draftFailure: string | null
}): string {
  const { key, from, to } = change
  const moved = `${key} is now in ${LABELS[to]}.`
  if (to === 'needs_approval') return `${moved} ${key} has a question waiting in Approvals.`
  if (from !== 'spec_draft') return moved
  if (change.draftFailure !== null)
    return `${moved} The last draft did not finish: ${change.draftFailure}.`
  if (to === 'spec_review' && change.latestVersion !== null)
    return `${moved} v${change.latestVersion} is ready to review.`
  return moved
}
