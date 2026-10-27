/** `git log` format that `coAuthored` reads: the hash, a unit separator, the body, a record separator. */
export const LOG_FORMAT = '%H%x1f%B%x1e'

/**
 * The commits whose trailers carry a `Co-Authored-By`. A trailer is a line of the message's last
 * paragraph, so the same words in a message's body do not count.
 */
export function coAuthored(log: string): string[] {
  return log
    .split('\x1e')
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.trim() !== '')
    .flatMap((record) => {
      const [sha = '', message = ''] = record.split('\x1f')
      const lastParagraph =
        message
          .trimEnd()
          .split(/\n\s*\n/)
          .at(-1) ?? ''
      return lastParagraph.split('\n').some((line) => /^co-authored-by\s*:/i.test(line))
        ? [sha.trim()]
        : []
    })
}
