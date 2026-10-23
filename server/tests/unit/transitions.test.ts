import { describe, expect, it } from 'vitest'
import { MOVES, nextState, type Facts, type Move } from '../../src/modules/tasks/transitions.js'
import { TASK_STATES, type TaskState } from '../../src/shared/vocabulary.js'

const DELIVERY: Facts = { run: 'delivery', hasSpec: true }
const FIRST_DRAFT: Facts = { run: 'spec', hasSpec: false }
const REDRAFT: Facts = { run: 'spec', hasSpec: true }

/**
 * The rows of the MVP spec's §5 table that slices 1 to 3 build — slice 2's from its own spec's
 * §4, slice 3's from its spec's §4 — written out independently of the implementation. A row
 * without facts holds for a delivery run on a task with a spec.
 */
const ALLOWED: [TaskState, Move, TaskState, Facts?][] = [
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
  // Slice 3: drafting and redrafting a spec, a draft's pauses, and its end.
  ['backlog', 'draft_spec', 'spec_draft', FIRST_DRAFT],
  ['spec_review', 'redraft', 'spec_draft', REDRAFT],
  ['spec_draft', 'finish_draft', 'spec_review', REDRAFT],
  ['spec_draft', 'drop_draft', 'backlog', FIRST_DRAFT],
  ['spec_draft', 'drop_draft', 'spec_review', REDRAFT],
  ['needs_approval', 'drop_draft', 'backlog', FIRST_DRAFT],
  ['needs_approval', 'drop_draft', 'spec_review', REDRAFT],
  ['blocked', 'drop_draft', 'backlog', FIRST_DRAFT],
  ['blocked', 'drop_draft', 'spec_review', REDRAFT],
  ['spec_draft', 'request_approval', 'needs_approval', FIRST_DRAFT],
  ['spec_draft', 'block', 'blocked', FIRST_DRAFT],
  ['needs_approval', 'answer', 'spec_draft', FIRST_DRAFT],
  ['blocked', 'answer', 'spec_draft', REDRAFT],
  ['blocked', 'resume', 'spec_draft', FIRST_DRAFT],
]

describe('nextState', () => {
  it.each(ALLOWED)('%s --%s--> %s, %o', (from, move, to, facts) => {
    expect(nextState(from, move, facts ?? DELIVERY)).toBe(to)
  })

  const allowedKeys = new Set(ALLOWED.map(([from, move]) => `${from}/${move}`))
  const refused = TASK_STATES.flatMap((from) =>
    MOVES.filter((move) => !allowedKeys.has(`${from}/${move}`)).map(
      (move) => [from, move] as const,
    ),
  )

  // Whatever the facts: a refused pair is refused for a draft and a delivery run alike.
  it.each(refused)('refuses %s --%s-->', (from, move) => {
    for (const facts of [DELIVERY, FIRST_DRAFT, REDRAFT])
      expect(nextState(from, move, facts)).toBeUndefined()
  })

  it('has no move the table above does not mention', () => {
    expect(new Set(MOVES)).toEqual(new Set(ALLOWED.map(([, move]) => move)))
  })
})
