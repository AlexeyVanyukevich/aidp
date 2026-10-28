import type { TaskState } from '../../shared/vocabulary.js'

/**
 * Every task move, and the only place one is decided. Routes, MCP tools, runner events and
 * the PR poller ask this table; none of them writes `state` on its own.
 */
export const MOVES = [
  'save_spec',
  'approve',
  'claim',
  'finish_review',
  'fail',
  'cancel',
  'rerun',
  'merge',
  'drag_done',
  'mark_done',
  'close_pr',
  'request_approval',
  'answer',
  'expire',
  'block',
  'resume',
  'draft_spec',
  'redraft',
  'finish_draft',
  'drop_draft',
] as const
export type Move = (typeof MOVES)[number]

/**
 * What a destination can depend on, beyond the state: the kind of the task's latest run, and
 * whether the task has a spec version. The caller reads them; the table picks the state.
 */
export interface Facts {
  run: 'spec' | 'delivery'
  hasSpec: boolean
}

/** A delivery run on a task with a spec: every move before slice 3 assumes it. */
export const DELIVERY_FACTS: Facts = { run: 'delivery', hasSpec: true }

/** A run's working state: a spec run drafts, a delivery run runs. */
const working = (facts: Facts): TaskState => (facts.run === 'spec' ? 'spec_draft' : 'running')

const TABLE: Record<
  Move,
  { from: readonly TaskState[]; to: TaskState | ((facts: Facts) => TaskState) }
> = {
  save_spec: { from: ['backlog', 'spec_review'], to: 'spec_review' },
  approve: { from: ['spec_review'], to: 'ready' },
  claim: { from: ['ready'], to: 'running' },
  finish_review: { from: ['running'], to: 'review' },
  fail: { from: ['running'], to: 'failed' },
  // A spec run's Cancel is `drop_draft`: Failed and Re-run are a delivery run's.
  cancel: { from: ['ready', 'running', 'needs_approval', 'blocked'], to: 'failed' },
  // An answer is accepted from Blocked only when the block is the question expiring; the
  // approvals service checks that, since the table cannot see why a card is blocked.
  request_approval: { from: ['running', 'spec_draft'], to: 'needs_approval' },
  answer: { from: ['needs_approval', 'blocked'], to: working },
  expire: { from: ['needs_approval'], to: 'blocked' },
  block: { from: ['running', 'spec_draft'], to: 'blocked' },
  resume: { from: ['blocked'], to: working },
  rerun: { from: ['failed'], to: 'ready' },
  merge: { from: ['review'], to: 'done' },
  drag_done: { from: ['review'], to: 'done' },
  mark_done: { from: ['backlog', 'spec_review', 'failed'], to: 'done' },
  close_pr: { from: ['review'], to: 'failed' },
  draft_spec: { from: ['backlog'], to: 'spec_draft' },
  redraft: { from: ['spec_review'], to: 'spec_draft' },
  finish_draft: { from: ['spec_draft'], to: 'spec_review' },
  // A draft that failed or was cancelled goes back where it came from (slice 3 spec, §2).
  drop_draft: {
    from: ['spec_draft', 'needs_approval', 'blocked'],
    to: (facts) => (facts.hasSpec ? 'spec_review' : 'backlog'),
  },
}

export function nextState(
  from: TaskState,
  move: Move,
  facts: Facts = DELIVERY_FACTS,
): TaskState | undefined {
  const row = TABLE[move]
  if (!row.from.includes(from)) return undefined
  return typeof row.to === 'function' ? row.to(facts) : row.to
}
