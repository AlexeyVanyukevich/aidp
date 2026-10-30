import { describe, expect, it } from 'vitest'
import { testCommandLine } from '../../src/card/testCommandLine'
import type { TaskState } from '../../src/types'

const STATES: TaskState[] = [
  'backlog',
  'spec_draft',
  'spec_review',
  'ready',
  'running',
  'needs_approval',
  'review',
  'done',
  'blocked',
  'failed',
]
const TESTING: TaskState[] = ['running', 'needs_approval', 'blocked', 'review']

const rows = STATES.flatMap((state) =>
  [
    ['npm run unit', state],
    [null, state],
  ].map(([testedWith, s]) => {
    const text = testedWith as string | null
    let expected: string | null = null
    if (s === 'done') expected = text === null ? 'No run tested this task.' : `Tested with: ${text}`
    else if (TESTING.includes(s as TaskState) && text !== null)
      expected = `This run tests with ${text}.`
    return [s as TaskState, text, expected] as const
  }),
)

describe('testCommandLine', () => {
  it.each(rows)('in %s with tested_with %j gives %j', (state, testedWith, expected) => {
    expect(testCommandLine(state, testedWith)).toBe(expected)
  })
})
