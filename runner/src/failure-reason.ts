/** The paragraph a Build reads when the runner, not Verify, started its round. */
export const REMINDER_TEXT =
  'This round was started by the runner, not by Verify, so no Verify has checked the latest Build’s proof that each test the branch adds or changes was seen failing. Besides fixing what this report names, give that proof in your closing paragraph for every such test that no build summary in the context proves, running it against the base’s code as your instructions say.'

const LISTED = 20

/** The reason a run ends with when a Verify failed and no further attempt follows. */
export function verifyFailedReason(
  attempt: number,
  verifyRuns: number,
  criteria: readonly { id: string; status: string }[],
): string {
  const ids = criteria.filter((c) => c.status === 'fail').map((c) => c.id)
  const more = ids.length > LISTED ? `, and ${ids.length - LISTED} more` : ''
  const runs = verifyRuns === 1 ? 'run' : 'runs'
  return `verify failed on attempt ${attempt}, after ${verifyRuns} Verify ${runs}: ${ids.slice(0, LISTED).join(', ')}${more}`
}
