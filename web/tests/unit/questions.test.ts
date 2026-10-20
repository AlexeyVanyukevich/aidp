import { describe, expect, it } from 'vitest'
import { questionsText } from '../../src/board/questions'

describe('questionsText', () => {
  it.each([
    [0, ''],
    [1, '1 question waiting'],
    [3, '3 questions waiting'],
  ])('counts %s as "%s"', (n, text) => {
    expect(questionsText(n)).toBe(text)
  })
})
