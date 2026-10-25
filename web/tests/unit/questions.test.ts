import { describe, expect, it } from 'vitest'
import { questionsText, waitingCount } from '../../src/board/questions'

describe('questionsText', () => {
  it.each([
    [0, ''],
    [1, '1 question waiting'],
    [3, '3 questions waiting'],
  ])('counts %s as "%s"', (n, text) => {
    expect(questionsText(n)).toBe(text)
  })
})

// Slice 3 spec §2: a batch of three is three questions waiting.
describe('waitingCount', () => {
  it.each([
    [[], 0],
    [[{ question_count: 1 }], 1],
    [[{ question_count: 3 }, { question_count: 1 }], 4],
  ])('sums %j to %i', (open, count) => {
    expect(waitingCount(open)).toBe(count)
  })
})
