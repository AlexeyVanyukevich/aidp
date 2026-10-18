import type { TaskCard, TaskState } from '../types'

export const MAIN_COLUMNS: TaskState[] = [
  'backlog',
  'spec_draft',
  'spec_review',
  'ready',
  'running',
  'needs_approval',
  'review',
  'done',
]
export const SIDE_COLUMNS: TaskState[] = ['blocked', 'failed']

export const LABELS: Record<TaskState, string> = {
  backlog: 'Backlog',
  spec_draft: 'Spec draft',
  spec_review: 'Spec review',
  ready: 'Ready',
  running: 'Running',
  needs_approval: 'Needs approval',
  review: 'Review',
  done: 'Done',
  blocked: 'Blocked',
  failed: 'Failed',
}

export function columns(tasks: TaskCard[]): Record<TaskState, TaskCard[]> {
  const result = Object.fromEntries(
    [...MAIN_COLUMNS, ...SIDE_COLUMNS].map((state) => [state, [] as TaskCard[]]),
  ) as Record<TaskState, TaskCard[]>
  for (const task of tasks) result[task.state].push(task)
  for (const list of Object.values(result)) list.sort((a, b) => a.position - b.position)
  return result
}

export function positionBetween(prev?: number, next?: number): number {
  if (prev === undefined && next === undefined) return 1
  if (prev === undefined) return next! - 1
  if (next === undefined) return prev + 1
  return (prev + next) / 2
}

/**
 * What a drop asks the server for, or `null` when the drop is not a move a person makes by
 * dragging. Reordering within a column is always allowed; the only move between columns is
 * Review → Done (spec §5).
 */
export function dropPatch(
  card: TaskCard,
  target: TaskState,
  before: TaskCard | undefined,
  column: TaskCard[],
): { position: number } | { state: 'done' } | null {
  if (card.state === target) {
    const others = column.filter((c) => c.id !== card.id)
    const index = before === undefined ? others.length : others.findIndex((c) => c.id === before.id)
    return { position: positionBetween(others[index - 1]?.position, others[index]?.position) }
  }
  if (card.state === 'review' && target === 'done') return { state: 'done' }
  return null
}

/**
 * Move up and Move down, the buttons that make a reorder without a drag (WCAG 2.5.7): one place
 * within the card's column, in position order. `null` at the column's end.
 */
export function stepPatch(
  card: TaskCard,
  column: TaskCard[],
  direction: 'up' | 'down',
): { position: number } | null {
  const index = column.findIndex((c) => c.id === card.id)
  if (index === -1) return null
  if (direction === 'up') {
    const above = column[index - 1]
    if (above === undefined) return null
    return { position: positionBetween(column[index - 2]?.position, above.position) }
  }
  const below = column[index + 1]
  if (below === undefined) return null
  return { position: positionBetween(below.position, column[index + 2]?.position) }
}

export function shortModel(id: string): string {
  return /(opus|sonnet|haiku)/.exec(id)?.[1] ?? id
}

export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<$0.01'
  return `$${usd.toFixed(2)}`
}
