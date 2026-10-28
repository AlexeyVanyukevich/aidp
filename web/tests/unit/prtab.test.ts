import { describe, expect, it } from 'vitest'
import { prStatus } from '../../src/card/blocks'
import type { TaskView } from '../../src/types'

interface Row {
  name: string
  state: TaskView['state']
  failure: string | null
  word: string
}

const ROWS: Row[] = [
  { name: 'merged: Done, no failure', state: 'done', failure: null, word: 'merged' },
  {
    name: 'closed PR marked done from Failed',
    state: 'done',
    failure: 'pull request closed without merging',
    word: 'closed',
  },
  { name: 'closed: Failed', state: 'failed', failure: null, word: 'closed' },
  { name: 'open: Review', state: 'review', failure: null, word: 'open' },
]

describe('prStatus', () => {
  it.each(ROWS)('$name', ({ state, failure, word }) => {
    expect(prStatus(state, failure)).toBe(word)
  })
})
