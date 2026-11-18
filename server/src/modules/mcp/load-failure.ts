/** A leading runner marker, with the whitespace after it. */
const MARKER = /^(?:FAIL|×|✗|❯)\s*/u

/**
 * True when a failing line shows only that a file or name could not load, so the test never ran:
 * it begins `Error: Cannot find module`, or `SyntaxError: The requested module` and says it
 * `does not provide an export named`, after at most one runner marker.
 */
export function showsOnlyLoadFailure(line: string): boolean {
  const rest = line.trimStart().replace(MARKER, '')
  if (rest.startsWith('Error: Cannot find module')) return true
  return (
    rest.startsWith('SyntaxError: The requested module') &&
    rest.includes('does not provide an export named')
  )
}
