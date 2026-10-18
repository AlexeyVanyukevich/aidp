import { describe, expect, it } from 'vitest'
import {
  editable,
  lintMessage,
  lintSummary,
  plural,
  savedMessage,
  SPEC_TEMPLATE,
} from '../../src/card/lint'

describe('lintMessage', () => {
  it.each([
    [{ code: 'no_requirements' }, 'The spec has no requirements.'],
    [
      { code: 'requirement_without_id', text: 'Users can retry' },
      'This requirement needs an id like R3: “Users can retry”.',
    ],
    [
      { code: 'criterion_without_id', text: 'Given x' },
      'This criterion needs an id like AC3: “Given x”.',
    ],
    [{ code: 'criterion_without_requirement', id: 'AC2' }, 'AC2 names no requirement.'],
    [{ code: 'requirement_without_criterion', id: 'R2' }, 'R2 has no acceptance criterion.'],
    [
      { code: 'unknown_requirement', id: 'AC2', text: 'R9' },
      'AC2 names R9, which is not a requirement.',
    ],
    [{ code: 'duplicate_id', id: 'R1' }, 'R1 is used twice.'],
    [{ code: 'something_new' }, 'something_new'],
  ])('%j', (finding, message) => {
    expect(lintMessage(finding)).toBe(message)
  })
})

describe('editable', () => {
  it.each([
    ['backlog', true],
    ['spec_review', true],
    ['ready', false],
    ['running', false],
    ['review', false],
  ] as const)('a spec in %s can be edited: %s', (state, expected) => {
    expect(editable(state)).toBe(expected)
  })
})

describe('the words for counts and outcomes', () => {
  it.each([
    [1, 'requirement', undefined, '1 requirement'],
    [2, 'requirement', undefined, '2 requirements'],
    [1, 'criterion', 'criteria', '1 criterion'],
    [3, 'criterion', 'criteria', '3 criteria'],
  ] as const)('plural(%s, %s)', (n, one, many, text) => {
    expect(plural(n, one, many)).toBe(text)
  })

  const lint = (approvable: boolean, findings: number, questions: number) => ({
    requirements: ['R1'],
    criteria: [{ id: 'AC1', requirements: ['R1'], text: 't' }],
    findings: Array.from({ length: findings }, () => ({ code: 'duplicate_id', id: 'R1' })),
    open_questions: Array.from({ length: questions }, (_, i) => `q${i}`),
    approvable,
  })

  it('sums up a clean spec', () => {
    expect(lintSummary(lint(true, 0, 0))).toBe('The spec lints clean: 1 requirement, 1 criterion.')
  })

  it.each([
    [lint(true, 0, 0), 'Saved v2. It lints clean and can be approved.'],
    [lint(false, 2, 1), 'Saved v2. It cannot be approved yet: 3 things to fix, listed under Lint.'],
    [lint(false, 0, 1), 'Saved v2. It cannot be approved yet: 1 thing to fix, listed under Lint.'],
  ])('announces a save: %#', (result, message) => {
    expect(savedMessage({ version: 2, lint: result })).toBe(message)
  })
})

it('offers the platform design’s template, which lints clean once filled', () => {
  expect(SPEC_TEMPLATE).toContain('## Requirements')
  expect(SPEC_TEMPLATE).toContain('## Acceptance criteria')
  expect(SPEC_TEMPLATE).toContain('## Open questions')
})
