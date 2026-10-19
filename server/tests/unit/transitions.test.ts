import { describe, expect, it } from 'vitest'
import { MOVES, nextState, type Move } from '../../src/modules/tasks/transitions.js'
import { TASK_STATES, type TaskState } from '../../src/shared/vocabulary.js'

/**
 * The rows of the MVP spec's §5 table that slices 1 and 2 build — slice 2's from its own spec's
 * §4 — written out independently of the implementation.
 */
const ALLOWED: [TaskState, Move, TaskState][] = [
  ['backlog', 'save_spec', 'spec_review'],
  ['spec_review', 'save_spec', 'spec_review'],
  ['spec_review', 'approve', 'ready'],
  ['ready', 'claim', 'running'],
  ['running', 'finish_review', 'review'],
  ['running', 'fail', 'failed'],
  ['ready', 'cancel', 'failed'],
  ['running', 'cancel', 'failed'],
  ['failed', 'rerun', 'ready'],
  ['review', 'merge', 'done'],
  ['review', 'drag_done', 'done'],
  ['review', 'close_pr', 'failed'],
  // Slice 2: pause, block, resume, and Cancel from the two new waiting states.
  ['running', 'request_approval', 'needs_approval'],
  ['needs_approval', 'answer', 'running'],
  ['blocked', 'answer', 'running'],
  ['needs_approval', 'expire', 'blocked'],
  ['running', 'block', 'blocked'],
  ['blocked', 'resume', 'running'],
  ['needs_approval', 'cancel', 'failed'],
  ['blocked', 'cancel', 'failed'],
]

describe('nextState', () => {
  it.each(ALLOWED)('%s --%s--> %s', (from, move, to) => {
    expect(nextState(from, move)).toBe(to)
  })

  const allowedKeys = new Set(ALLOWED.map(([from, move]) => `${from}/${move}`))
  const refused = TASK_STATES.flatMap((from) =>
    MOVES.filter((move) => !allowedKeys.has(`${from}/${move}`)).map(
      (move) => [from, move] as const,
    ),
  )

  it.each(refused)('refuses %s --%s-->', (from, move) => {
    expect(nextState(from, move)).toBeUndefined()
  })

  it('has no move the table above does not mention', () => {
    expect(new Set(MOVES)).toEqual(new Set(ALLOWED.map(([, move]) => move)))
  })
})
