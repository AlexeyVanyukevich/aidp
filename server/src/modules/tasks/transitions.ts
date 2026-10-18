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
] as const
export type Move = (typeof MOVES)[number]

const TABLE: Record<Move, { from: readonly TaskState[]; to: TaskState }> = {
  save_spec: { from: ['backlog', 'spec_review'], to: 'spec_review' },
  approve: { from: ['spec_review'], to: 'ready' },
  claim: { from: ['ready'], to: 'running' },
  finish_review: { from: ['running'], to: 'review' },
  fail: { from: ['running'], to: 'failed' },
  cancel: { from: ['ready', 'running'], to: 'failed' },
  rerun: { from: ['failed'], to: 'ready' },
  merge: { from: ['review'], to: 'done' },
  drag_done: { from: ['review'], to: 'done' },
  close_pr: { from: ['review'], to: 'failed' },
}

export function nextState(from: TaskState, move: Move): TaskState | undefined {
  const row = TABLE[move]
  return row.from.includes(from) ? row.to : undefined
}
