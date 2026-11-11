/** Pure rules of the board-reading tools: key folding, task-key parsing, the filter's pattern. */

const TASK_KEY = /^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]*)$/

/** A project key as the tools look it up: upper-cased, nothing else changed. */
export const foldKey = (key: string): string => key.toUpperCase()

/** A task key, upper-cased, split into its project key and number; null when it is malformed. */
export function parseTaskKey(
  key: string,
): { folded: string; project: string; number: number } | null {
  const folded = foldKey(key)
  const match = TASK_KEY.exec(folded)
  if (match === null) return null
  const number = Number(match[2])
  // A number past the integer column's range names no task.
  if (!Number.isSafeInteger(number) || number > 2_147_483_647) return null
  return { folded, project: match[1]!, number }
}

/**
 * The `LIKE` pattern for a filter: trimmed, with `\`, `%` and `_` escaped (the escape character
 * is `\`), wrapped in wildcards. Null when the trimmed filter is empty, which keeps every task.
 */
export function filterPattern(filter: string | undefined): string | null {
  const trimmed = (filter ?? '').trim()
  if (trimmed === '') return null
  return `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}
