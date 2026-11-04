/**
 * Whether a migration's `context_md` is wrapped in a Markdown code fence: the first line opens
 * one with three backticks or tildes, and the last non-blank line closes it with that character.
 */
export function isFenced(text: string): boolean {
  const lines = text.split(/\r?\n/)
  const open = /^(`{3,}|~{3,})/.exec(lines[0] ?? '')
  if (open === null) return false
  let last = lines.length - 1
  while (last > 0 && (lines[last] ?? '').trim() === '') last--
  if (last === 0) return false
  const char = open[1]?.[0] ?? '`'
  const closing = (lines[last] ?? '').trim()
  return closing.length >= 3 && [...closing].every((c) => c === char)
}

/**
 * The content between two lines of backticks, one longer than the longest run inside it (at
 * least three). The content is never escaped or cut. The runner has a copy; both read one table.
 */
export function fenceMigration(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`
}
