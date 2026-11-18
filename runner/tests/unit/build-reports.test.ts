import { describe, expect, it } from 'vitest'
import { foldBuildReports, type SavedBuildReport } from '../../src/build-reports.js'

const fail = (name: string, command = 'c') => ({
  name,
  command,
  way: 'before_code' as const,
  failing_line: 'l',
})
const save = (phase: string, attempt: number, ...names: string[]): SavedBuildReport => ({
  phaseId: phase,
  attempt,
  tests: names.map((n) => fail(n)),
})

const ROWS: {
  name: string
  saves: SavedBuildReport[]
  expected: { attempt: number; tests: unknown[] }[]
}[] = [
  {
    name: 'two saves in one phase, the later entry replacing the earlier',
    saves: [
      { phaseId: 'p1', attempt: 1, tests: [fail('a', 'old'), fail('b')] },
      { phaseId: 'p1', attempt: 1, tests: [fail('a', 'new')] },
    ],
    expected: [{ attempt: 1, tests: [fail('b'), fail('a', 'new')] }],
  },
  {
    name: 'two phases at attempts 1 and 2, kept apart and ordered by attempt',
    saves: [save('p2', 2, 'b'), save('p1', 1, 'a')],
    expected: [
      { attempt: 1, tests: [fail('a')] },
      { attempt: 2, tests: [fail('b')] },
    ],
  },
  {
    name: 'an entry of attempt 1 not replaced by attempt 2’s entry for the same name',
    saves: [
      { phaseId: 'p1', attempt: 1, tests: [fail('a', 'one')] },
      { phaseId: 'p2', attempt: 2, tests: [fail('a', 'two')] },
    ],
    expected: [
      { attempt: 1, tests: [fail('a', 'one')] },
      { attempt: 2, tests: [fail('a', 'two')] },
    ],
  },
  {
    name: 'two phases sharing an attempt, folded together',
    saves: [save('p1', 1, 'a', 'b'), save('p3', 1, 'b')],
    expected: [{ attempt: 1, tests: [fail('a'), fail('b')] }],
  },
  { name: 'no saves', saves: [], expected: [] },
]

describe('foldBuildReports', () => {
  it.each(ROWS)('$name', ({ saves, expected }) => {
    expect(foldBuildReports(saves)).toEqual(expected)
  })
})
