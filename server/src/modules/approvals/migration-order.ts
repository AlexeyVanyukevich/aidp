/** A migration's name: its file name without the last extension (`004_helps.ts` → `004_helps`). */
export function migrationName(file: string): string {
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

/**
 * Whether a new migration sorts too early: its name is equal to, or sorts before, a sibling's.
 * Names compare by UTF-16 code unit, the order the migrator applies them in. `siblings` are
 * file names; `index.*` files are the registry, not migrations. `after` is the greatest sibling
 * name, which a new name must sort after; null when there is none.
 */
export function migrationOrder(
  file: string,
  siblings: string[],
): { tooEarly: boolean; after: string | null } {
  const names = siblings.filter((s) => !s.startsWith('index.')).map(migrationName)
  const name = migrationName(file)
  let after: string | null = null
  for (const n of names) if (after === null || n > after) after = n
  return { tooEarly: after !== null && name <= after, after }
}
