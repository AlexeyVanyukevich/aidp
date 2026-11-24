import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api'
import {
  answerFieldHint,
  answerRefusal,
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
  applySuggestion,
  suggestionMessage,
  fillNoteFromReview,
  fillRerunNote,
  defaultRerunPicks,
  type PrReviewResult,
  type FindingPick,
  preSendProblem,
  NO_WORDS_WITH_PLAN,
  failureText,
  fillEveryAnswer,
  hasWholeAnswers,
  suggestHeading,
  helpAnnouncement,
  newlyEnded,
  questionHelp,
  singleAnswer,
  type ReviewResult,
} from '../../src/card/approvals'
import {
  actionProblem,
  fileButtonName,
  prStepControl,
  REVIEW_STEP_LABEL,
  rerunNoteFor,
  specStepLock,
  specStepPresent,
  specGateAnswer,
  specRefusal,
  specStepPress,
  specFindings,
  wordsField,
  unfiledNotice,
} from '../../src/card/approvals'
import { keysFor } from '../../src/stream'
import type { ApprovalView, BatchQuestion, HelpView } from '../../src/types'

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

// Helps.
const help = (change: Partial<HelpView>): HelpView => ({
  id: 'h1',
  approval_id: 'a1',
  decision: 'question',
  subject: null,
  question_index: null,
  mode: 'suggest',
  status: 'succeeded',
  result: { mode: 'suggest', option_id: 'b', text: 'Use four.', reasoning: 'r', unsure: 'u' },
  reason: null,
  created_at: '2026-10-20T10:00:00Z',
  ...change,
})

describe('questionHelp', () => {
  it.each<
    [string, HelpView[], 'suggest' | 'explain', { busy: boolean; failure?: string; shown: boolean }]
  >([
    ['nothing asked', [], 'suggest', { busy: false, shown: false }],
    ['a succeeded help shows its result', [help({})], 'suggest', { busy: false, shown: true }],
    [
      'a running help makes its button busy',
      [
        help({ id: 'h2', status: 'running', result: null, created_at: '2026-10-20T10:05:00Z' }),
        help({}),
      ],
      'suggest',
      { busy: true, shown: true },
    ],
    [
      'a failed help gives its reason and keeps the older result',
      [
        help({
          id: 'h2',
          status: 'failed',
          result: null,
          reason: 'no budget',
          created_at: '2026-10-20T10:05:00Z',
        }),
        help({}),
      ],
      'suggest',
      { busy: false, failure: 'no budget', shown: true },
    ],
    ['another mode is its own', [help({})], 'explain', { busy: false, shown: false }],
    [
      'another question is its own',
      [help({ question_index: 1 })],
      'suggest',
      { busy: false, shown: false },
    ],
  ])('%s', (_name, helps, mode, expected) => {
    const state = questionHelp(helps, 'a1', null)[mode]
    expect({ busy: state.busy, shown: state.shown !== undefined, failure: state.failure }).toEqual({
      failure: undefined,
      ...expected,
    })
  })
})

describe('help announcements', () => {
  const batch = { ...base, kind: 'questions' as const, question_count: 3, questions: [] }
  it.each<[string, HelpView, ApprovalView | undefined, string]>([
    [
      'a suggestion in a batch',
      help({ question_index: 1 }),
      batch,
      'Suggested answer ready for question 2 of 3',
    ],
    [
      'an explanation of a single request',
      help({ mode: 'explain' }),
      base,
      'Explanation ready for the open question',
    ],
    [
      'a failure',
      help({ status: 'failed', reason: 'budget' }),
      base,
      'No suggestion for the open question: budget',
    ],
  ])('says %s', (_name, h, approval, text) => {
    expect(helpAnnouncement(h, approval)).toBe(text)
  })

  it('words a failure on the question itself', () => {
    expect(failureText('explain', 'x')).toBe('No explanation: x')
  })

  it('names a help once, when it ends after being seen in flight', () => {
    const seen = new Map<string, string>()
    expect(newlyEnded(seen, [help({ status: 'running', result: null })])).toEqual([])
    expect(newlyEnded(seen, [help({})]).map((h) => h.id)).toEqual(['h1'])
    expect(newlyEnded(seen, [help({})])).toEqual([])
  })

  it('does not announce a help that was already finished when the card opened', () => {
    expect(newlyEnded(new Map(), [help({})])).toEqual([])
  })
})

describe('applySuggestion', () => {
  const result = {
    mode: 'suggest' as const,
    option_id: 'b',
    text: 'Use four.',
    reasoning: 'r',
    unsure: 'u',
  }
  it.each([
    [
      'selects the option and replaces the words',
      'question' as const,
      { option: 'a', text: 'old' },
      result,
      { option: 'b', text: 'Use four.' },
    ],
    [
      'keeps the chosen option when the suggestion has none',
      'question' as const,
      { option: 'a', text: 'old' },
      { ...result, option_id: undefined },
      { option: 'a', text: 'Use four.' },
    ],
    [
      'keeps the words when the suggestion has none',
      'question' as const,
      { text: 'old' },
      { ...result, text: undefined },
      { option: 'b', text: 'old' },
    ],
    [
      'a plan suggestion of words alone clears the option',
      'plan' as const,
      { option: 'approve', text: 'old' },
      { ...result, option_id: undefined },
      { text: 'Use four.' },
    ],
    [
      'a plan suggestion of approve and words chooses approve and empties the words',
      'plan' as const,
      { text: '' },
      { ...result, option_id: 'approve' },
      { option: 'approve', text: '' },
    ],
    [
      'a plan suggestion of approve and words replaces typed words',
      'plan' as const,
      { text: 'typed' },
      { ...result, option_id: 'approve' },
      { option: 'approve', text: '' },
    ],
    [
      'a plan suggestion of approve alone empties typed words',
      'plan' as const,
      { text: 'typed' },
      { ...result, option_id: 'approve', text: undefined },
      { option: 'approve', text: '' },
    ],
    [
      'a plan suggestion of approve alone chooses approve',
      'plan' as const,
      { text: '' },
      { ...result, option_id: 'approve', text: undefined },
      { option: 'approve', text: '' },
    ],
  ])('%s', (_name, kind, current, suggested, expected) => {
    const { option_id, text, ...rest } = suggested
    const clean = {
      ...rest,
      ...(option_id === undefined ? {} : { option_id }),
      ...(text === undefined ? {} : { text }),
    }
    expect(applySuggestion(kind, current, clean)).toEqual(expected)
  })
})

describe('suggestionMessage', () => {
  const approve = { mode: 'suggest' as const, option_id: 'approve', reasoning: 'r', unsure: 'u' }
  it.each([
    [
      'approve with words',
      'plan' as const,
      { text: '' },
      { ...approve, text: 'Note.' },
      'Approve plan chosen. An approval carries no words: the suggested words are not sent, and the words field is empty.',
    ],
    [
      'approve alone over typed words',
      'plan' as const,
      { text: 'typed' },
      approve,
      'Approve plan chosen. An approval carries no words: the words field is empty.',
    ],
    [
      'approve alone over an empty field',
      'plan' as const,
      { text: '' },
      approve,
      'Approve plan chosen.',
    ],
    [
      'words alone at a plan gate',
      'plan' as const,
      { text: '' },
      { mode: 'suggest' as const, text: 'Add a step.', reasoning: 'r', unsure: 'u' },
      undefined,
    ],
    [
      'an option with words at a question',
      'question' as const,
      { text: 'typed' },
      { ...approve, option_id: 'a', text: 'Because.' },
      undefined,
    ],
  ])('%s', (_name, kind, current, result, expected) => {
    expect(suggestionMessage(kind, current, result)).toBe(expected)
  })
})

describe('preSendProblem', () => {
  it.each([
    [
      'plan with approve and words',
      'plan' as const,
      { option: 'approve', text: 'x' },
      NO_WORDS_WITH_PLAN,
    ],
    [
      'plan with approve and blank words',
      'plan' as const,
      { option: 'approve', text: '  ' },
      undefined,
    ],
    ['plan with words alone', 'plan' as const, { text: 'x' }, undefined],
    [
      'question with an option and words',
      'question' as const,
      { option: 'a', text: 'x' },
      undefined,
    ],
  ])('%s', (_name, kind, choice, expected) => {
    expect(preSendProblem(kind, choice)).toBe(expected)
  })
})

describe('singleAnswer', () => {
  it.each([
    ['an option', { option: 'a', text: '' }, { option_id: 'a' }],
    ['words', { text: ' Use 4 ' }, { text: 'Use 4' }],
    ['both', { option: 'a', text: 'and jitter' }, { option_id: 'a', text: 'and jitter' }],
    ['neither', { text: '  ' }, null],
  ])('sends %s', (_name, choice, expected) => {
    expect(singleAnswer(choice)).toEqual(expected)
  })
})

describe('fillNoteFromReview', () => {
  type Finding = Omit<ReviewResult['findings'][number], 'destination' | 'evidence'> &
    Partial<Pick<ReviewResult['findings'][number], 'destination' | 'evidence'>>
  const review = (findings: Finding[]): ReviewResult => ({
    mode: 'review',
    verdict: 'changes',
    blockers: findings.length,
    findings: findings.map((f) => ({ destination: 'blocker', evidence: 'R1', ...f })),
    unsure: 'The deadline.',
  })
  const retry: Finding = { kind: 'missing', where: 'R1', text: 'No retry limit' }
  const LINE = '- blocker, missing (R1): No retry limit'
  it.each<[string, string, Finding[], string]>([
    ['an empty note', '', [retry], LINE],
    [
      'a whitespace-only note, two findings in order',
      '  \n ',
      [retry, { kind: 'risk', text: 'Slow' }],
      `${LINE}\n- blocker, risk: Slow`,
    ],
    ['a note ending in a blank line', 'Also rename X.\n\n', [retry], `Also rename X.\n\n${LINE}`],
    ['words with no trailing space', 'Also rename X.', [retry], `Also rename X.\n\n${LINE}`],
    ['a note that already holds the lines', LINE, [retry], `${LINE}\n\n${LINE}`],
    [
      'one finding of each kind',
      '',
      [
        { kind: 'missing', text: 'a' },
        { kind: 'contradiction', where: 'R2', text: 'b' },
        { kind: 'uncheckable', text: 'c' },
        { kind: 'risk', where: 'R4', text: 'd' },
      ],
      '- blocker, missing: a\n- blocker, contradiction (R2): b\n- blocker, uncheckable: c\n- blocker, risk (R4): d',
    ],
  ])('fills %s', (_name, note, findings, expected) => {
    expect(fillNoteFromReview(note, review(findings))).toBe(expected)
  })
})

describe('fillNoteFromReview with picks', () => {
  type Finding = Omit<ReviewResult['findings'][number], 'destination' | 'evidence'> &
    Partial<Pick<ReviewResult['findings'][number], 'destination' | 'evidence'>>
  const review = (findings: Finding[]): ReviewResult => ({
    mode: 'review',
    verdict: 'changes',
    blockers: findings.length,
    findings: findings.map((f) => ({ destination: 'blocker', evidence: 'R1', ...f })),
    unsure: 'u',
  })
  const ab = (recommended: number): Finding => ({
    kind: 'missing',
    where: 'R1',
    text: 'X',
    choices: ['A', 'B'],
    recommended,
  })
  const abc: Finding = { ...ab(1), choices: ['A', 'B', 'C'] }
  const plain: Finding = { kind: 'risk', text: 'Slow' }
  const head = '- blocker, missing (R1): X'
  it.each<[string, string, Finding[], FindingPick[], string]>([
    ['the recommended choice picked', '', [ab(0)], [1], `${head}\n  Decision: B`],
    ['the recommended choice picked, no marker', '', [ab(0)], [0], `${head}\n  Decision: A`],
    [
      'as written, recommended first',
      '',
      [ab(0)],
      ['written'],
      `${head}\n  Open choice, ask me: A (recommended); or B`,
    ],
    [
      'as written, recommended last',
      '',
      [ab(1)],
      ['written'],
      `${head}\n  Open choice, ask me: A; or B (recommended)`,
    ],
    [
      'as written, three choices',
      '',
      [abc],
      ['written'],
      `${head}\n  Open choice, ask me: A; B (recommended); or C`,
    ],
    ['no picks', '', [ab(0)], [], `${head}\n  Open choice, ask me: A (recommended); or B`],
    ['a finding without choices as written', '', [plain], ['written'], '- blocker, risk: Slow'],
    [
      'one left out between two',
      '',
      [plain, ab(0), plain],
      ['written', 'out', 'written'],
      '- blocker, risk: Slow\n- blocker, risk: Slow',
    ],
    ['every finding left out', 'Keep this.', [plain, ab(0)], ['out', 'out'], 'Keep this.'],
    ['every finding left out, blank note', '', [plain], ['out'], ''],
    ['a choice after words', 'Words.', [ab(0)], [1], `Words.\n\n${head}\n  Decision: B`],
  ])('fills %s', (_name, note, findings, picks, expected) => {
    expect(fillNoteFromReview(note, review(findings), picks)).toBe(expected)
  })
})

const refused = (details?: Record<string, unknown>) =>
  new ApiError(400, 'validation_error', 'm', details)

describe('answerRefusal', () => {
  const LENGTH = 'The answer is longer than 4,000 characters.'
  const NOT_ALLOWED =
    'Approving the plan carries no words. Clear them, or press Clear choice to ask for changes.'
  it.each([
    [
      'a service not_allowed',
      refused({ field: 'text', findings: [{ field: 'text', code: 'not_allowed' }] }),
      NOT_ALLOWED,
    ],
    [
      'a service too_long',
      refused({ field: 'text', findings: [{ field: 'text', code: 'too_long' }] }),
      LENGTH,
    ],
    [
      'a schema maxLength',
      refused({ issues: [{ instancePath: '/text', keyword: 'maxLength' }] }),
      LENGTH,
    ],
    ['a conflict', new ApiError(409, 'conflict', 'm'), undefined],
    ['a server error', new ApiError(500, 'internal', 'm'), undefined],
  ])('maps %s', (_name, error, expected) => {
    expect(answerRefusal(error)).toBe(expected)
  })
})

// The whole-batch suggestion (AIDP-172).

const whole = (change: Partial<HelpView>): HelpView =>
  help({
    id: 'w1',
    mode: 'suggest_all',
    question_index: null,
    result: {
      mode: 'suggest_all',
      answers: [
        { question_id: 'q1', option_id: 'a', reasoning: 'wr1', unsure: 'wu1' },
        { question_id: 'q2', text: 'Words of the whole', reasoning: 'wr2', unsure: 'wu2' },
      ],
    },
    ...change,
  })
const own = (change: Partial<HelpView>): HelpView =>
  help({
    id: 'o1',
    question_index: 1,
    result: { mode: 'suggest', text: 'Own words', reasoning: 'or', unsure: 'ou' },
    ...change,
  })
const T = (minute: number) => `2026-10-20T10:0${minute}:00Z`

describe('questionHelp of a batch question', () => {
  interface Row {
    name: string
    helps: HelpView[]
    busy: boolean
    source: 'own' | 'whole' | undefined
    words: string | undefined
    heading: string | undefined
    failure: string | undefined
  }
  const rows: Row[] = [
    {
      name: 'only a batch answer',
      helps: [whole({})],
      busy: false,
      source: 'whole',
      words: 'Words of the whole',
      heading: 'Suggested with the whole batch',
      failure: undefined,
    },
    {
      name: 'only an own answer',
      helps: [own({})],
      busy: false,
      source: 'own',
      words: 'Own words',
      heading: 'Suggested answer',
      failure: undefined,
    },
    {
      name: 'an own answer newer than the batch’s',
      helps: [whole({ created_at: T(1) }), own({ created_at: T(2) })],
      busy: false,
      source: 'own',
      words: 'Own words',
      heading: 'Suggested answer',
      failure: undefined,
    },
    {
      name: 'a batch answer newer than the own one',
      helps: [own({ created_at: T(1) }), whole({ created_at: T(2) })],
      busy: false,
      source: 'whole',
      words: 'Words of the whole',
      heading: 'Suggested with the whole batch',
      failure: undefined,
    },
    {
      name: 'a newer failed whole-batch help keeps the older answer',
      helps: [
        own({ created_at: T(1) }),
        whole({ id: 'w2', status: 'failed', result: null, reason: 'no budget', created_at: T(2) }),
      ],
      busy: false,
      source: 'own',
      words: 'Own words',
      heading: 'Suggested answer',
      failure: 'no budget',
    },
    {
      name: 'a running whole-batch help makes the button busy',
      helps: [whole({ id: 'w2', status: 'running', result: null, created_at: T(2) })],
      busy: true,
      source: undefined,
      words: undefined,
      heading: undefined,
      failure: undefined,
    },
    {
      name: 'a running own help makes the button busy',
      helps: [own({ id: 'o2', status: 'queued', result: null, created_at: T(2) })],
      busy: true,
      source: undefined,
      words: undefined,
      heading: undefined,
      failure: undefined,
    },
    {
      name: 'another request’s whole-batch help is not this one’s',
      helps: [whole({ approval_id: 'other' })],
      busy: false,
      source: undefined,
      words: undefined,
      heading: undefined,
      failure: undefined,
    },
  ]
  it.each(rows)('$name', (row) => {
    const state = questionHelp(row.helps, 'a1', 1, 'q2').suggest
    const shown = state.shown?.mode === 'suggest' ? state.shown : undefined
    expect({
      busy: state.busy,
      source: state.source,
      words: shown?.text,
      heading: state.source === undefined ? undefined : suggestHeading(state.source),
      failure: state.failure,
    }).toEqual({
      busy: row.busy,
      source: row.source,
      words: row.words,
      heading: row.heading,
      failure: row.failure,
    })
  })

  it('shows a suggestion made of the question’s own answer, with its option', () => {
    const state = questionHelp([whole({})], 'a1', 0, 'q1').suggest
    expect(state.shown).toEqual({
      mode: 'suggest',
      option_id: 'a',
      reasoning: 'wr1',
      unsure: 'wu1',
    })
  })

  it('shows nothing from the batch for a question its result lacks', () => {
    expect(questionHelp([whole({})], 'a1', 2, 'q3').suggest.shown).toBeUndefined()
  })

  it('leaves Explain on its own question only', () => {
    expect(
      questionHelp([whole({ status: 'running', result: null })], 'a1', 1, 'q2').explain.busy,
    ).toBe(false)
  })

  it('leaves a single request out of the batch', () => {
    const state = questionHelp([whole({ status: 'running', result: null })], 'a1', null).suggest
    expect(state.busy).toBe(false)
  })
})

describe('hasWholeAnswers', () => {
  it.each<[string, HelpView[], boolean]>([
    ['no help', [], false],
    ['a succeeded whole-batch help', [whole({})], true],
    ['a failed one', [whole({ status: 'failed', result: null })], false],
    ['an own suggestion', [own({})], false],
    ['another request’s', [whole({ approval_id: 'x' })], false],
  ])('%s', (_name, helps, expected) => {
    expect(hasWholeAnswers(helps, 'a1')).toBe(expected)
  })
})

describe('fillEveryAnswer', () => {
  const questions: BatchQuestion[] = ['q1', 'q2', 'q3', 'q4'].map((id) => ({
    id,
    question: id,
    options: [{ id: 'a', label: 'A' }],
    recommendation: null,
    context_md: null,
  }))
  const suggestion = (id: string, change: Record<string, unknown> = {}) => ({
    mode: 'suggest' as const,
    option_id: 'a',
    text: `Words ${id}`,
    reasoning: 'r',
    unsure: 'u',
    ...change,
  })
  const shown = Object.fromEntries(questions.map((q) => [q.id, suggestion(q.id)]))

  interface Row {
    name: string
    choices: Record<string, { option?: string; text: string }>
    shown?: typeof shown
    filled: string[]
    message: string
    kept: Record<string, { option?: string; text: string }>
  }
  const rows: Row[] = [
    {
      name: 'two answered by hand, one cleared, one untouched',
      choices: {
        q1: { text: 'typed' },
        q2: { option: 'a', text: '' },
        q3: { text: '   ' },
      },
      filled: ['q3', 'q4'],
      message: 'Filled 2 answers; skipped 2 already answered.',
      kept: { q1: { text: 'typed' }, q2: { option: 'a', text: '' } },
    },
    {
      name: 'one left',
      choices: { q1: { text: 'x' }, q2: { text: 'y' }, q3: { text: 'z' } },
      filled: ['q4'],
      message: 'Filled 1 answer; skipped 3 already answered.',
      kept: { q1: { text: 'x' }, q2: { text: 'y' }, q3: { text: 'z' } },
    },
    {
      name: 'every question answered',
      choices: {
        q1: { text: 'x' },
        q2: { text: 'y' },
        q3: { text: 'z' },
        q4: { option: 'a', text: '' },
      },
      filled: [],
      message: 'Every question is already answered; nothing was filled.',
      kept: {
        q1: { text: 'x' },
        q2: { text: 'y' },
        q3: { text: 'z' },
        q4: { option: 'a', text: '' },
      },
    },
    {
      name: 'nothing answered, a newer own answer for q2',
      choices: {},
      shown: { ...shown, q2: suggestion('q2', { option_id: undefined, text: 'Own newer' }) },
      filled: ['q1', 'q2', 'q3', 'q4'],
      message: 'Filled 4 answers; skipped 0 already answered.',
      kept: {},
    },
  ]
  it.each(rows)('$name', (row) => {
    const result = fillEveryAnswer(questions, row.choices, (q) => (row.shown ?? shown)[q.id])
    expect(result.filled).toEqual(row.filled)
    expect(result.message).toBe(row.message)
    for (const [id, kept] of Object.entries(row.kept)) expect(result.choices[id]).toEqual(kept)
    for (const id of row.filled)
      expect(result.choices[id]?.text).toBe((row.shown ?? shown)[id]?.text ?? '')
  })

  it('fills a newer own answer for a question asked again on its own', () => {
    const result = fillEveryAnswer(questions, {}, (q) =>
      q.id === 'q2'
        ? suggestion('q2', { option_id: undefined, text: 'Own newer' })
        : suggestion(q.id),
    )
    expect(result.choices.q2).toEqual({ text: 'Own newer' })
    expect(result.choices.q1).toEqual({ option: 'a', text: 'Words q1' })
  })
})

describe('whole-batch announcements', () => {
  const batch = { ...base, kind: 'questions' as const, question_count: 3, questions: [] }
  it.each<[string, HelpView, string]>([
    ['success', whole({}), 'Suggested answers ready for all 3 questions'],
    [
      'failure',
      whole({ status: 'failed', result: null, reason: 'the helper ended with an error' }),
      'No suggestions for the batch: the helper ended with an error',
    ],
  ])('says %s once for the batch', (_name, h, text) => {
    expect(helpAnnouncement(h, batch)).toBe(text)
    expect(newlyEnded(new Map([[h.id, 'running']]), [h]).map(helpAnnouncement2(batch))).toEqual([
      text,
    ])
  })
  it('words a whole-batch failure on the question itself like a suggestion’s', () => {
    expect(failureText('suggest_all', 'x')).toBe('No suggestion: x')
  })
})

const helpAnnouncement2 = (approval: ApprovalView) => (h: HelpView) => helpAnnouncement(h, approval)

describe('fillNoteFromReview by destination', () => {
  const finding = (
    destination: 'blocker' | 'next_gate' | 'outside',
    extra: Partial<ReviewResult['findings'][number]> = {},
  ): ReviewResult['findings'][number] => ({
    kind: 'risk',
    where: 'Context',
    text: `a ${destination}`,
    destination,
    evidence: 'Context',
    ...extra,
  })
  const result = (findings: ReviewResult['findings']): ReviewResult => ({
    mode: 'review',
    verdict: 'changes',
    blockers: findings.filter((f) => f.destination === 'blocker').length,
    findings,
    unsure: 'u',
  })

  it('names each destination and never writes an outside finding', () => {
    const note = fillNoteFromReview(
      '',
      result([finding('blocker'), finding('next_gate'), finding('outside')]),
    )
    expect(note).toBe(
      '- blocker, risk (Context): a blocker\n- next gate, risk (Context): a next_gate',
    )
  })

  it('puts a Decision line under a blocker with a chosen choice', () => {
    const note = fillNoteFromReview(
      '',
      result([finding('blocker', { choices: ['A', 'B'], recommended: 0 }), finding('outside')]),
      [1, 'written'],
    )
    expect(note).toBe('- blocker, risk (Context): a blocker\n  Decision: B')
  })
})

describe('fillRerunNote', () => {
  const finding = (
    destination: 'blocker' | 'outside',
    text: string,
  ): PrReviewResult['findings'][number] => ({
    kind: 'bug',
    where: 'a.ts:1',
    text,
    matters: 'm',
    destination,
    evidence: 'a.ts:1',
  })
  const review = (
    commit: string | null,
    ...findings: PrReviewResult['findings']
  ): PrReviewResult => ({
    mode: 'code_review',
    verdict: 'changes',
    blockers: 1,
    findings,
    next_step: 'fix_by_hand',
    reasoning: 'r',
    unsure: 'u',
    commit,
  })
  const at = '2026-11-17T10:30:00.000Z'

  it('begins with the review’s date and commit and lists the chosen findings with evidence', () => {
    const text = fillRerunNote(
      'Mine.',
      review('0123456789abcdef', finding('blocker', 'Off by one'), finding('outside', 'Elsewhere')),
      at,
      ['in', 'out'],
    )
    expect(text).toBe(
      'Mine.\n\nFrom the pull request review of 2026-11-17 10:30, at commit 0123456789ab:\n- blocker, bug (a.ts:1): Off by one Evidence: a.ts:1',
    )
  })

  it('says unknown when the review has no commit', () => {
    expect(fillRerunNote('', review(null, finding('blocker', 'x')), at, ['in'])).toContain(
      'at commit unknown:',
    )
  })

  it('leaves the note as it was when nothing is chosen', () => {
    expect(fillRerunNote('Mine.', review(null, finding('outside', 'x')), at, ['out'])).toBe('Mine.')
  })

  it('starts blockers at Put in the note and outside findings at Leave out', () => {
    expect(
      defaultRerunPicks(review(null, finding('blocker', 'a'), finding('outside', 'b'))),
    ).toEqual(['in', 'out'])
  })
})

const REVIEW_BASE = {
  mode: 'review' as const,
  verdict: 'changes' as const,
  blockers: 1,
  unsure: 'u',
}
const BLOCK = {
  kind: 'missing' as const,
  where: 'R1',
  text: 'No retry limit',
  destination: 'blocker' as const,
  evidence: 'R1',
}
const NEXT = { ...BLOCK, text: 'Vague wording', destination: 'next_gate' as const }
const OUT = (on_board: { key: string; state: string } | null) => ({
  kind: 'risk' as const,
  text: 'Elsewhere',
  destination: 'outside' as const,
  evidence: 'a.ts:1',
  title: 'Elsewhere',
  on_board,
})

describe('the step labels of Review spec (R3)', () => {
  it('names each step, and none repeats a Spec tab button', () => {
    expect(REVIEW_STEP_LABEL).toEqual({
      approve: 'Approve as it stands',
      approve_with_note: 'Approve with these findings',
      redraft: 'Redraft with these findings',
    })
    for (const label of Object.values(REVIEW_STEP_LABEL))
      expect(['Approve', 'Redraft', 'Use these findings']).not.toContain(label)
  })
})

describe('specStepPresent and specStepLock (R9)', () => {
  it.each<[string, number | null, number | null, boolean]>([
    ['the latest version’s result', 3, 3, true],
    ['an older result', 2, 3, false],
    ['a result with no version', null, 3, false],
  ])('shows a step for %s: %s', (_name, resultVersion, latestVersion, expected) => {
    expect(specStepPresent(resultVersion, latestVersion)).toBe(expected)
  })

  const locks: [string, 'approve' | 'approve_with_note' | 'redraft', object, string | null][] = [
    ['approve is free', 'approve', {}, null],
    ['approve with the radio disabled', 'approve', { canApprove: false }, 'unapprovable'],
    [
      'approve_with_note with the radio disabled',
      'approve_with_note',
      { canApprove: false },
      'unapprovable',
    ],
    ['approve while rephrasing', 'approve', { rephrasing: true }, 'rephrasing'],
    ['redraft is free', 'redraft', {}, null],
    ['redraft with the radio disabled', 'redraft', { canApprove: false }, null],
    ['redraft while rephrasing', 'redraft', { rephrasing: true }, 'rephrasing'],
  ]
  it.each(locks)('%s', (_name, step, change, expected) => {
    expect(specStepLock(step, { canApprove: true, rephrasing: false, ...change })).toBe(expected)
  })
})

describe('specGateAnswer (R5, AC1)', () => {
  it.each<[string, { option?: string; text: string }, object]>([
    [
      'approve with blank words',
      { option: 'approve', text: '   ' },
      { send: true, action: 'approve' },
    ],
    [
      'approve with words',
      { option: 'approve', text: '  keep it small  ' },
      { send: true, action: 'approve', note: 'keep it small' },
    ],
    [
      'words with no option',
      { text: '  split it  ' },
      { send: true, action: 'redraft', note: 'split it' },
    ],
    [
      'only spaces with no option',
      { text: '   ' },
      { send: false, message: 'Write what to change, or choose Approve spec.' },
    ],
  ])('%s', (_name, choice, expected) => {
    expect(specGateAnswer(choice)).toEqual(expected)
  })
})

describe('wordsField (R4, AC2)', () => {
  const spec = 'The spec-writer redrafts from these words and the current version.'
  const planner = 'The planner reads this with the approved spec. It does not change the spec.'
  it.each<[string, 'spec' | 'plan' | 'question', string | undefined, string, string | undefined]>([
    ['the spec gate with no option', 'spec', undefined, 'What to change', spec],
    ['the spec gate with Approve spec', 'spec', 'approve', 'Note for the planner', planner],
    ['a plan request', 'plan', undefined, 'Changes to ask for', undefined],
    ['a question request', 'question', undefined, 'Your answer', undefined],
  ])('%s', (_name, gate, option, label, hint) => {
    const field = wordsField(gate, option)
    expect(field.label).toBe(label)
    if (hint !== undefined) expect(field.hint).toBe(hint)
  })
})

describe('specFindings (R8, AC3)', () => {
  const res = (findings: object[], blockers: number): ReviewResult =>
    ({ ...REVIEW_BASE, blockers, findings }) as ReviewResult
  const blockerLine = '- blocker, missing (R1): No retry limit'
  const nextLine = '- next gate, missing (R1): Vague wording'
  const rows: {
    name: string
    result: ReviewResult
    choice: { option?: string; text: string }
    picks?: FindingPick[]
    enabled?: boolean
    expected: { choice: { option?: string; text: string }; message: string }
  }[] = [
    {
      name: 'a blocker with Approve spec chosen',
      result: res([BLOCK], 1),
      choice: { option: 'approve', text: 'Mine' },
      expected: {
        choice: { text: `Mine\n\n${blockerLine}` },
        message: 'Findings put in What to change.',
      },
    },
    {
      name: 'next-gate findings only, radio enabled',
      result: res([NEXT], 0),
      choice: { text: '' },
      expected: {
        choice: { option: 'approve', text: nextLine },
        message: 'Findings put in Note for the planner.',
      },
    },
    {
      name: 'next-gate findings only, radio disabled',
      result: res([NEXT], 0),
      choice: { text: '' },
      enabled: false,
      expected: { choice: { text: nextLine }, message: 'Findings put in What to change.' },
    },
    {
      name: 'every finding left out, no option',
      result: res([BLOCK], 1),
      choice: { text: 'Mine' },
      picks: ['out'],
      expected: {
        choice: { text: 'Mine' },
        message: 'Every finding is left out; What to change is unchanged.',
      },
    },
    {
      name: 'every finding left out, Approve spec',
      result: res([NEXT], 0),
      choice: { option: 'approve', text: 'Mine' },
      picks: ['out'],
      expected: {
        choice: { option: 'approve', text: 'Mine' },
        message: 'Every finding is left out; Note for the planner is unchanged.',
      },
    },
  ]
  it.each(rows)('$name', (row) => {
    expect(specFindings(row.choice, row.result, row.picks ?? [], row.enabled ?? true)).toEqual(
      row.expected,
    )
  })
})

describe('specStepPress (R9, AC4)', () => {
  const res = (findings: object[]): ReviewResult =>
    ({ ...REVIEW_BASE, findings, next_step: 'redraft', reasoning: 'r' }) as ReviewResult
  const rows: {
    name: string
    step: 'approve' | 'approve_with_note' | 'redraft'
    findings: object[]
    picks?: FindingPick[]
    text?: string
    expected: object
  }[] = [
    {
      name: 'approve sends the field’s words as the note',
      step: 'approve',
      findings: [],
      text: ' My words ',
      expected: {
        choice: { option: 'approve', text: ' My words ' },
        send: { send: true, action: 'approve', note: 'My words' },
      },
    },
    {
      name: 'approve_with_note puts the picked lines after the words',
      step: 'approve_with_note',
      findings: [NEXT],
      text: 'Mine',
      expected: {
        choice: { option: 'approve', text: 'Mine\n\n- next gate, missing (R1): Vague wording' },
        send: {
          send: true,
          action: 'approve',
          note: 'Mine\n\n- next gate, missing (R1): Vague wording',
        },
      },
    },
    {
      name: 'redraft puts the picked lines after the words and clears the choice',
      step: 'redraft',
      findings: [BLOCK],
      text: 'Mine',
      expected: {
        choice: { text: 'Mine\n\n- blocker, missing (R1): No retry limit' },
        send: {
          send: true,
          action: 'redraft',
          note: 'Mine\n\n- blocker, missing (R1): No retry limit',
        },
      },
    },
    {
      name: 'approve_with_note with nothing to write sends nothing',
      step: 'approve_with_note',
      findings: [NEXT],
      picks: ['out'],
      expected: {
        choice: { option: 'approve', text: '' },
        send: {
          send: false,
          message: 'Write the note for the planner, or choose Approve spec and press Send answer.',
        },
      },
    },
    {
      name: 'redraft with nothing to write sends nothing',
      step: 'redraft',
      findings: [BLOCK],
      picks: ['out'],
      expected: { choice: { text: '' }, send: { send: false, message: 'Say what to change.' } },
    },
  ]
  it.each(rows)('$name', (row) => {
    expect(
      specStepPress(row.step, res(row.findings), row.picks ?? [], { text: row.text ?? '' }),
    ).toEqual(row.expected)
  })
})

describe('specRefusal (R7)', () => {
  const tooLong = refused({ field: 'note' })
  it.each<[string, 'approve' | 'redraft', unknown, object]>([
    [
      'approve, note too long',
      'approve',
      tooLong,
      { field: 'The note is longer than 4,000 characters.' },
    ],
    [
      'redraft, note too long',
      'redraft',
      refused({ field: 'note', issues: [{ instancePath: '/note', keyword: 'maxLength' }] }),
      { field: 'The note is longer than 4,000 characters.' },
    ],
    [
      'a conflict',
      'approve',
      new ApiError(409, 'conflict', 'm'),
      { problem: 'This card changed meanwhile; its latest state is shown.' },
    ],
    [
      'approve refused by lint',
      'approve',
      refused(),
      { problem: 'The spec cannot be approved until it lints clean and has no open questions.' },
    ],
    [
      'anything else',
      'redraft',
      new ApiError(500, 'internal', 'm'),
      { problem: 'That did not work. Try again.' },
    ],
  ])('%s', (_name, action, error, expected) => {
    expect(specRefusal(action, error)).toEqual(expected)
  })
})

describe('unfiledNotice (R4, AC15)', () => {
  const withOutside = (a: ReturnType<typeof OUT>, b: ReturnType<typeof OUT>) =>
    ({ ...REVIEW_BASE, findings: [a, b], next_step: 'redraft', reasoning: 'r' }) as ReviewResult
  const done = { key: 'AIDP-3', state: 'backlog' }
  it.each([
    [
      'both null',
      withOutside(OUT(null), OUT(null)),
      '2 outside findings not filed; they leave the card with this review.',
    ],
    [
      'one null',
      withOutside(OUT(null), OUT(done)),
      '1 outside finding not filed; it leaves the card with this review.',
    ],
    ['both set', withOutside(OUT(done), OUT(done)), null],
  ])('%s', (_name, result, expected) => {
    expect(unfiledNotice(result)).toBe(expected)
  })
})

describe('fileButtonName (R13)', () => {
  it.each([
    ['the own project', 'A title', undefined, 'AIDP', 'File as a task: A title'],
    ['the own project named', 'A title', 'AIDP', 'AIDP', 'File as a task: A title'],
    ['another project', 'A title', 'CHR', 'AIDP', 'File as a task: A title in CHR'],
  ])('%s', (_name, title, project, own, expected) => {
    expect(fileButtonName(title, project, own)).toBe(expected)
  })
})

describe('prStepControl (R9–R12)', () => {
  const pr = (next_step: string, commit: string | null): PrReviewResult =>
    ({
      mode: 'code_review',
      verdict: 'changes',
      blockers: 1,
      findings: [],
      next_step,
      reasoning: 'r',
      unsure: 'u',
      commit,
      skipped: [],
    }) as unknown as PrReviewResult
  it.each([
    ['merge', 'abc', { kind: 'merge' }],
    ['merge', null, { kind: 'no_commit' }],
    ['merge_and_file', 'abc', { kind: 'merge_and_file' }],
    ['merge_and_file', null, { kind: 'no_commit' }],
    ['rerun_keep', null, { kind: 'rerun', plan: 'keep' }],
    ['rerun_again', 'abc', { kind: 'rerun', plan: 'again' }],
    ['fix_by_hand', 'abc', { kind: 'send_back' }],
    ['fix_by_hand', null, { kind: 'send_back' }],
  ])('%s with commit %s', (step, commit, expected) => {
    expect(prStepControl(pr(step, commit))).toEqual(expected)
  })
})

describe('rerunNoteFor (R11, AC14)', () => {
  it('holds the blocker line and not the outside finding', () => {
    const result = {
      mode: 'code_review',
      verdict: 'changes',
      blockers: 1,
      findings: [
        {
          kind: 'bug',
          where: 'a.ts:1',
          text: 'Off by one',
          matters: 'm',
          destination: 'blocker',
          evidence: 'a.ts:1',
        },
        {
          kind: 'fit',
          where: 'b.ts:2',
          text: 'Stray',
          matters: 'm',
          destination: 'outside',
          evidence: 'b.ts:2',
          title: 'T',
        },
      ],
      next_step: 'rerun_again',
      reasoning: 'r',
      unsure: 'u',
      commit: 'abcdef1234567',
      skipped: [],
    } as unknown as PrReviewResult
    const at = '2026-11-20T10:30:00Z'
    const note = rerunNoteFor(result, at)
    expect(note).toBe(fillRerunNote('', result, at, defaultRerunPicks(result)))
    expect(note).toContain('Off by one')
    expect(note).not.toContain('Stray')
  })
})

describe('actionProblem (R13)', () => {
  it.each([
    [
      'a duplicate names its key',
      new ApiError(409, 'conflict', 'm', { reason: 'duplicate', key: 'AIDP-3', state: 'ready' }),
      'AIDP-3 (ready) already has this title.',
    ],
    [
      'gh’s reason',
      new ApiError(502, 'gh_failed', 'm', { stderr: 'head branch was modified' }),
      'GitHub did not do it: head branch was modified',
    ],
    [
      'a stale card',
      new ApiError(409, 'conflict', 'm', { reason: 'not_offered' }),
      'This card changed meanwhile; its latest state is shown.',
    ],
    ['anything else', new Error('x'), 'That did not work. Try again.'],
  ])('%s', (_name, error, expected) => {
    expect(actionProblem(error)).toBe(expected)
  })
})
