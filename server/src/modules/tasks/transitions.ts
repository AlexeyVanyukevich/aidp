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
  'close_pr',
  'request_approval',
  'answer',
  'expire',
  'block',
  'resume',
] as const
export type Move = (typeof MOVES)[number]

const TABLE: Record<Move, { from: readonly TaskState[]; to: TaskState }> = {
  save_spec: { from: ['backlog', 'spec_review'], to: 'spec_review' },
  approve: { from: ['spec_review'], to: 'ready' },
  claim: { from: ['ready'], to: 'running' },
  finish_review: { from: ['running'], to: 'review' },
  fail: { from: ['running'], to: 'failed' },
  cancel: { from: ['ready', 'running', 'needs_approval', 'blocked'], to: 'failed' },
  // An answer is accepted from Blocked only when the block is the question expiring; the
  // approvals service checks that, since the table cannot see why a card is blocked.
  request_approval: { from: ['running'], to: 'needs_approval' },
  answer: { from: ['needs_approval', 'blocked'], to: 'running' },
  expire: { from: ['needs_approval'], to: 'blocked' },
  block: { from: ['running'], to: 'blocked' },
  resume: { from: ['blocked'], to: 'running' },
  rerun: { from: ['failed'], to: 'ready' },
  merge: { from: ['review'], to: 'done' },
  drag_done: { from: ['review'], to: 'done' },
  close_pr: { from: ['review'], to: 'failed' },
}

export function nextState(from: TaskState, move: Move): TaskState | undefined {
  const row = TABLE[move]
  return row.from.includes(from) ? row.to : undefined
}
