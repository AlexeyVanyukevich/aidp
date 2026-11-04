/** The text with CRLF read as LF and any run of final newlines (or none) read as one. */
function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')
}

/** Whether two texts are the same migration content (R1): equal after those two readings. */
export function sameMigrationContent(a: string, b: string): boolean {
  return normalise(a) === normalise(b)
}

/**
 * The content between two lines of backticks, one longer than the longest run inside it (at
 * least three). The content is never escaped or cut. The server has a copy; both read one table.
 */
export function fenceMigration(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`
}
