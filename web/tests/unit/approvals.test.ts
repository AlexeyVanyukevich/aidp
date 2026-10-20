import { describe, expect, it } from 'vitest'
import {
  answerSummary,
  currentApproval,
  fieldLabel,
  headingFor,
  optionName,
} from '../../src/card/approvals'
import { keysFor } from '../../src/stream'
import type { ApprovalView } from '../../src/types'

const base: ApprovalView = {
  id: 'ap',
  run_id: 'r',
  phase_id: 'p',
  kind: 'question',
  question: 'How many retries?',
  options: [
    { id: 'a', label: 'Three' },
    { id: 'b', label: 'Four', impact: 'Matches the email worker' },
  ],
  recommendation: 'b',
  context_md: null,
  files: null,
  status: 'open',
  answer: null,
  created_at: '2026-10-20T10:00:00Z',
  answered_at: null,
}

describe('optionName', () => {
  // The mark is in the button's name, not only its look (spec §11).
  it.each([
    ['a', 'Three'],
    ['b', 'Four (recommended)'],
  ])('names option %s "%s"', (id, name) => {
    expect(
      optionName(
        base.options.find((o) => o.id === id)!,
        base.recommendation,
      ),
    ).toBe(name)
  })
})

describe('headingFor', () => {
  it.each([
    ['open', 'Open question'],
    ['expired', 'Unanswered question'],
  ] as const)('heads a %s approval "%s"', (status, heading) => {
    expect(headingFor(status)).toBe(heading)
  })
})

describe('fieldLabel', () => {
  it.each([
    ['question', 'Your answer'],
    ['out_of_plan', 'Your answer'],
    ['plan', 'Changes to ask for'],
  ] as const)('labels the field of a %s "%s"', (kind, label) => {
    expect(fieldLabel(kind)).toBe(label)
  })
})

describe('answerSummary', () => {
  it.each<[string, Partial<ApprovalView>, string]>([
    ['an option', { status: 'answered', answer: { option_id: 'b' } }, 'Four'],
    ['words', { status: 'answered', answer: { text: 'Use five.' } }, 'Use five.'],
    [
      'an option and words',
      { status: 'answered', answer: { option_id: 'a', text: 'With jitter.' } },
      'Three — With jitter.',
    ],
    ['a withdrawn question', { status: 'withdrawn' }, 'Withdrawn: the run was cancelled.'],
  ])('sums up %s', (_name, change, summary) => {
    expect(answerSummary({ ...base, ...change })).toBe(summary)
  })
})

describe('currentApproval', () => {
  const expired = { ...base, status: 'expired' as const }
  it.each<[string, ApprovalView[], 'blocked' | 'needs_approval', string | undefined]>([
    ['an open question', [base], 'needs_approval', 'ap'],
    ['an expired question blocking its card', [expired], 'blocked', 'ap'],
    ['an expired question on a card no longer blocked', [expired], 'needs_approval', undefined],
    ['only answered ones', [{ ...base, status: 'answered' }], 'needs_approval', undefined],
  ])('finds %s', (_name, list, state, id) => {
    expect(currentApproval(list, state)?.id).toBe(id)
  })
})

describe('keysFor approval notices', () => {
  it.each(['approval.requested', 'approval.answered'] as const)(
    'refreshes what %s changes',
    (topic) => {
      expect(keysFor({ topic, taskId: 't' })).toEqual([
        ['approvals', 't'],
        ['approvals', 'open'],
        ['task', 't'],
        ['board'],
      ])
    },
  )
})
