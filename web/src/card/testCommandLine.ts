import type { TaskState } from '../types'

/** States where a run is under way or waiting on the owner, so "this run" has a meaning. */
const RUN_UNDER_WAY: readonly TaskState[] = ['running', 'needs_approval', 'blocked', 'review']

/**
 * The line a card shows about the command its run tests with, or null for none. A Done card
 * says what its last started run used, or that no run tested it.
 */
export function testCommandLine(state: TaskState, testedWith: string | null): string | null {
  if (state === 'done')
    return testedWith === null ? 'No run tested this task.' : `Tested with: ${testedWith}`
  if (testedWith !== null && RUN_UNDER_WAY.includes(state))
    return `This run tests with ${testedWith}.`
  return null
}
