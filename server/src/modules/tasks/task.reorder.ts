import type { TaskState } from '../../shared/vocabulary.js'

export interface ReorderInput {
  id: string
  state: TaskState
  position: number
  number: number
}

/**
 * Each state's tasks keep their order by position, ties broken by number, and take the
 * positions 1, 2, … n. Returns the new position of every task, by id.
 */
export function renumber(tasks: readonly ReorderInput[]): Map<string, number> {
  const byState = new Map<TaskState, ReorderInput[]>()
  for (const task of tasks) {
    const column = byState.get(task.state) ?? []
    column.push(task)
    byState.set(task.state, column)
  }
  const result = new Map<string, number>()
  for (const column of byState.values()) {
    column.sort((a, b) => a.position - b.position || a.number - b.number)
    column.forEach((task, index) => result.set(task.id, index + 1))
  }
  return result
}
