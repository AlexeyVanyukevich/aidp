import { describe, expect, it } from 'vitest'
import {
  readTitleSuggestion,
  type TitleRunFacts,
  type TitleSuggestion,
} from '../../src/modules/tasks/title-suggestion.js'

const suggestion = (decision: string | null) => ({ title: 'T', reason: 'R', decision })
const run = (over: Partial<TitleRunFacts>): TitleRunFacts => ({
  status: 'queued',
  failure_reason: null,
  suggestion: null,
  ...over,
})

const CASES: [string, TitleRunFacts | undefined, TitleSuggestion | null][] = [
  ['no run', undefined, null],
  ['queued', run({ status: 'queued' }), { status: 'working' }],
  ['running', run({ status: 'running' }), { status: 'working' }],
  [
    'succeeded, undecided',
    run({ status: 'succeeded', suggestion: suggestion(null) }),
    { status: 'ready', title: 'T', reason: 'R' },
  ],
  ['succeeded, accepted', run({ status: 'succeeded', suggestion: suggestion('accepted') }), null],
  ['succeeded, discarded', run({ status: 'succeeded', suggestion: suggestion('discarded') }), null],
  ['succeeded, nothing stored', run({ status: 'succeeded' }), null],
  [
    'failed',
    run({ status: 'failed', failure_reason: 'the title phase failed' }),
    { status: 'failed', reason: 'the title phase failed' },
  ],
  ['cancelled', run({ status: 'cancelled' }), null],
]

describe('readTitleSuggestion', () => {
  it.each(CASES)('%s', (_name, input, expected) => {
    expect(readTitleSuggestion(input)).toEqual(expected)
  })
})
