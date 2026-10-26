import { describe, expect, it } from 'vitest'
import {
  answerFieldHint,
  answerFieldLabel,
  answerSummary,
  batchAnswer,
  batchAnswerLines,
  batchHeading,
  currentApproval,
  fieldLabel,
  codeLabel,
  headingFor,
  migrationPath,
  optionName,
  unanswered,
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
  questions: null,
  question_count: 1,
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

// Slice 3 spec §11: a batch, answered whole in one form.
const BATCH: ApprovalView = {
  ...base,
  kind: 'questions',
  question: '2 questions about the spec',
  options: [],
  recommendation: null,
  question_count: 2,
  questions: [
    {
      id: 'q1',
      question: 'How often?',
      options: [
        { id: 'three', label: 'Three times' },
        { id: 'five', label: 'Five times', impact: 'Slower' },
      ],
      recommendation: 'five',
      context_md: null,
    },
    { id: 'q2', question: 'Which errors?', options: [], recommendation: null, context_md: null },
  ],
}
const QUESTIONS = BATCH.questions ?? []

describe('a batch', () => {
  it.each([
    ['open', 'Open questions'],
    ['expired', 'Unanswered questions'],
  ] as const)('is headed, when %s, "%s"', (status, heading) => {
    expect(batchHeading(status)).toBe(heading)
  })

  it('names each answer field by its question’s number, and says when it is optional', () => {
    expect(answerFieldLabel(2)).toBe('Your answer to question 2')
    expect(answerFieldHint(true)).toBe('Optional when you choose an option.')
    expect(answerFieldHint(false)).toBe('Write your answer.')
  })

  it.each<[string, Record<string, { option?: string; text: string }>, number[]]>([
    ['nothing answered', {}, [0, 1]],
    ['an option for the first', { q1: { option: 'five', text: '' } }, [1]],
    ['blank words are no answer', { q1: { option: 'five', text: '' }, q2: { text: '  ' } }, [1]],
    ['both answered', { q1: { text: 'Four' }, q2: { text: 'Only 5xx' } }, []],
  ])('lists what is unanswered: %s', (_name, choices, gaps) => {
    expect(unanswered(QUESTIONS, choices)).toEqual(gaps)
  })

  it('sends each question’s option and words, trimmed, leaving out what is empty', () => {
    expect(
      batchAnswer(QUESTIONS, { q1: { option: 'five', text: ' ' }, q2: { text: ' Only 5xx ' } }),
    ).toEqual({
      answers: [
        { question_id: 'q1', option_id: 'five' },
        { question_id: 'q2', text: 'Only 5xx' },
      ],
    })
  })

  it('lists, once answered, each question with the answer given', () => {
    expect(
      batchAnswerLines({
        ...BATCH,
        status: 'answered',
        answer: {
          answers: [
            { question_id: 'q1', option_id: 'five', text: 'and log it' },
            { question_id: 'q2', text: 'Only 5xx' },
          ],
        },
      }),
    ).toEqual([
      { question: 'How often?', answer: 'Five times — and log it' },
      { question: 'Which errors?', answer: 'Only 5xx' },
    ])
  })
})

describe('a migration request', () => {
  const migration: ApprovalView = {
    ...base,
    kind: 'migration',
    files: ['server/src/db/migrations/004_x.ts'],
  }
  it('has its path, and other kinds have none', () => {
    expect(migrationPath(migration)).toBe('server/src/db/migrations/004_x.ts')
    expect(migrationPath({ ...base, kind: 'out_of_plan', files: ['a.ts'] })).toBeUndefined()
  })
  it('names the code block after the path', () => {
    expect(codeLabel('a/b.ts')).toBe('Contents of a/b.ts')
  })
})
