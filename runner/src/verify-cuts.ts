import type { DiffSection } from './pr-diff.js'
import { DIFF_MAX, diffCutPoint, testOutputLeftOut } from './phases/handoff.js'

const MAX_PATHS = 20

/**
 * The pull request's note on what the Verify handoff left out, or '' when it left out nothing.
 * `sections` is null when the diff's sections could not be matched to its paths. Pure.
 */
export function cutLines(diff: string, sections: DiffSection[] | null, testOutput: string): string {
  let note = ''
  if (diff.length > DIFF_MAX) {
    const head = `The diff was ${diff.length} characters. The Verify handoff held its first ${DIFF_MAX} and told the verifier to read the rest in verify.diff`
    if (sections === null) {
      note += `${head}, from line ${diffCutPoint(diff).line}.\n\n`
    } else {
      const lines = diff.split('\n')
      if (lines.at(-1) === '') lines.pop()
      // The character offset where each line ends, its line break included.
      const ends: number[] = []
      let at = 0
      for (const line of lines) {
        at += line.length + 1
        ends.push(Math.min(at, diff.length))
      }
      const paths = sections
        .filter((s) => (ends[s.first_line + s.lines - 2] ?? diff.length) > DIFF_MAX)
        .filter((s) => s.skip === undefined)
        .map((s) => s.path)
      if (paths.length === 0)
        note += `${head}. Every file not wholly in the handoff is a lockfile or a generated file.\n\n`
      else {
        const listed = paths.slice(0, MAX_PATHS).map((p) => `\`${p}\``)
        const more = paths.length - listed.length
        note += `${head}. Files not wholly in the handoff: ${listed.join(', ')}${more > 0 ? `, and ${more} more.` : '.'}\n\n`
      }
    }
  }
  const left = testOutputLeftOut(testOutput)
  if (left > 0)
    note += `The test output was ${testOutput.length} characters. The Verify handoff left out ${left} of them, which are in test-output.txt.\n\n`
  return note
}
