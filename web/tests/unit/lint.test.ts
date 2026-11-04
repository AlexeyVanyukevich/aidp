import { describe, expect, it } from 'vitest'
import type { TaskState } from '../../src/types'
import {
  editable,
  hasDraft,
  viewHeading,
  viewButtons,
  specControls,
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
    [
      { code: 'unknown_marker', id: 'AC1', text: 'Owner' },
      'AC1 has “Owner” in its parentheses, which is neither a requirement id nor owner.',
    ],
    [
      { code: 'prose_in_list', section: 'Requirements', text: 'x' },
      'Under Requirements every line must be an item or indented under one: “x”.',
    ],
    [
      { code: 'prose_in_list', section: 'Acceptance criteria', text: 'y' },
      'Under Acceptance criteria every line must be an item or indented under one: “y”.',
    ],
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

// Slice 3 spec §11: what the Spec tab offers in each state.
describe('specControls', () => {
  it.each([
    ['backlog', { describe: true, draft: true, redraft: false, drafting: false }],
    ['spec_draft', { describe: false, draft: false, redraft: false, drafting: true }],
    ['spec_review', { describe: true, draft: false, redraft: true, drafting: false }],
    ['ready', { describe: false, draft: false, redraft: false, drafting: false }],
    ['needs_approval', { describe: false, draft: false, redraft: false, drafting: false }],
    ['failed', { describe: false, draft: false, redraft: false, drafting: false }],
  ] as const)('in %s: %o', (state, controls) => {
    expect(specControls(state)).toEqual(controls)
  })
})

describe('hasDraft', () => {
  it.each([
    { name: 'no edit yet', draft: undefined, baseline: 'a', expected: false },
    { name: 'text equal to the baseline', draft: 'a', baseline: 'a', expected: false },
    { name: 'text that differs', draft: 'ab', baseline: 'a', expected: true },
    { name: 'text emptied', draft: '', baseline: 'a', expected: true },
  ])('is $expected for $name', ({ draft, baseline, expected }) => {
    expect(hasDraft(draft, baseline)).toBe(expected)
  })
})

describe('viewHeading', () => {
  it.each([
    {
      name: 'a saved version',
      version: { version: 1, status: 'draft' },
      draft: false,
      text: 'Spec v1 · draft',
    },
    {
      name: 'an approved version',
      version: { version: 3, status: 'approved' },
      draft: false,
      text: 'Spec v3 · approved',
    },
    {
      name: 'a draft over a version',
      version: { version: 2, status: 'draft' },
      draft: true,
      text: 'Spec v2 · unsaved changes',
    },
    {
      name: 'a draft with no version',
      version: undefined,
      draft: true,
      text: 'New spec · unsaved changes',
    },
  ])('reads $text for $name', ({ version, draft, text }) => {
    expect(viewHeading(version, draft)).toBe(text)
  })
})

describe('viewButtons', () => {
  const none = { edit: false, writeSpec: false, approve: false, draftSpec: false }
  const rows: {
    name: string
    state: TaskState
    version: boolean
    draft: boolean
    expected: ReturnType<typeof viewButtons>
  }[] = [
    {
      name: 'backlog, no spec',
      state: 'backlog',
      version: false,
      draft: false,
      expected: { ...none, writeSpec: true, draftSpec: true },
    },
    {
      name: 'backlog, draft over no spec',
      state: 'backlog',
      version: false,
      draft: true,
      expected: { ...none, edit: true, draftSpec: true },
    },
    {
      name: 'spec review',
      state: 'spec_review',
      version: true,
      draft: false,
      expected: { ...none, edit: true, approve: true },
    },
    {
      name: 'spec review, draft',
      state: 'spec_review',
      version: true,
      draft: true,
      expected: { ...none, edit: true, approve: true },
    },
    { name: 'spec draft', state: 'spec_draft', version: true, draft: false, expected: none },
    { name: 'ready', state: 'ready', version: true, draft: false, expected: none },
    { name: 'running', state: 'running', version: true, draft: false, expected: none },
  ]
  it.each(rows)('offers the right buttons in $name', ({ state, version, draft, expected }) => {
    expect(viewButtons(state, version, draft)).toEqual(expected)
  })
})
