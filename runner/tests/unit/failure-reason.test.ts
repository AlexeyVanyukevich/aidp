import { describe, expect, it } from 'vitest'
import { verifyFailedReason } from '../../src/failure-reason.js'

type Criteria = { id: string; status: string }[]
const fails = (n: number): Criteria =>
  Array.from({ length: n }, (_, i) => ({ id: `AC${i + 1}`, status: 'fail' }))

const ROWS: { name: string; attempt: number; runs: number; criteria: Criteria; text: string }[] = [
  {
    name: 'one Verify run',
    attempt: 3,
    runs: 1,
    criteria: fails(1),
    text: 'verify failed on attempt 3, after 1 Verify run: AC1',
  },
  {
    name: 'two runs',
    attempt: 4,
    runs: 2,
    criteria: fails(2),
    text: 'verify failed on attempt 4, after 2 Verify runs: AC1, AC2',
  },
  {
    name: 'report order, pass and owner left out',
    attempt: 3,
    runs: 3,
    criteria: [
      { id: 'AC5', status: 'fail' },
      { id: 'AC2', status: 'pass' },
      { id: 'AC1', status: 'owner' },
      { id: 'AC3', status: 'fail' },
    ],
    text: 'verify failed on attempt 3, after 3 Verify runs: AC5, AC3',
  },
  {
    name: '25 failed ids',
    attempt: 4,
    runs: 2,
    criteria: fails(25),
    text: `verify failed on attempt 4, after 2 Verify runs: ${fails(20)
      .map((c) => c.id)
      .join(', ')}, and 5 more`,
  },
]

describe('verifyFailedReason', () => {
  it.each(ROWS)('$name', ({ attempt, runs, criteria, text }) => {
    expect(verifyFailedReason(attempt, runs, criteria)).toBe(text)
  })
})
