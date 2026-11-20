import { describe, expect, it } from 'vitest'
import type { ApprovalKind } from '../../src/shared/vocabulary.js'
import {
  checkDecisionResult,
  batchResultOf,
  checkBatchResult,
  checkHelpResult,
  decisionResultOf,
  hasInFlight,
  isCurrent,
  lostHelps,
  questionOf,
  resultOf,
  suggestRoute,
  type BatchAnswerInput,
  type HelpResultInput,
} from '../../src/modules/approvals/help-rules.js'

const OPTIONS = [
  { id: 'a', label: 'Red' },
  { id: 'b', label: 'Blue' },
]
const SUGGEST = { reasoning: 'It matches the logo.', unsure: 'Whether print differs.' }
const EXPLAIN = { asked: 'Which colour?', matters: 'It is the brand.', leads_to: 'Red or blue.' }

describe('checkHelpResult', () => {
  it.each<[string, 'suggest' | 'explain', HelpResultInput, { field: string; code: string }[]]>([
    ['an option with reasoning', 'suggest', { option_id: 'b', ...SUGGEST }, []],
    ['words with reasoning', 'suggest', { text: 'Use teal.', ...SUGGEST }, []],
    [
      'an option the question does not offer',
      'suggest',
      { option_id: 'c', ...SUGGEST },
      [{ field: 'option_id', code: 'unknown_option' }],
    ],
    [
      'neither option nor words',
      'suggest',
      { ...SUGGEST },
      [{ field: 'option_id', code: 'required' }],
    ],
    [
      'no reasoning',
      'suggest',
      { option_id: 'a', unsure: 'x' },
      [{ field: 'reasoning', code: 'required' }],
    ],
    [
      'no statement of what is unsure',
      'suggest',
      { option_id: 'a', reasoning: 'x' },
      [{ field: 'unsure', code: 'required' }],
    ],
    [
      'an explanation fields on a suggestion',
      'suggest',
      { option_id: 'a', ...SUGGEST, asked: 'q' },
      [{ field: 'asked', code: 'not_allowed' }],
    ],
    ['an explanation of three parts', 'explain', { ...EXPLAIN }, []],
    [
      'an explanation carrying an option',
      'explain',
      { ...EXPLAIN, option_id: 'a' },
      [{ field: 'option_id', code: 'not_allowed' }],
    ],
    [
      'an explanation missing a part',
      'explain',
      { asked: 'q', matters: 'm' },
      [{ field: 'leads_to', code: 'required' }],
    ],
  ])('%s', (_name, mode, input, findings) => {
    expect(checkHelpResult(mode, OPTIONS, input)).toEqual(findings)
  })
})

describe('checkHelpResult by request kind', () => {
  it.each<[string, ApprovalKind, HelpResultInput, { field: string; code: string }[]]>([
    [
      'a plan suggestion of approve with words',
      'plan',
      { option_id: 'a', text: 'Also rename it.', ...SUGGEST },
      [{ field: 'text', code: 'not_allowed' }],
    ],
    ['a plan suggestion of approve alone', 'plan', { option_id: 'a', ...SUGGEST }, []],
    ['a plan suggestion of words alone', 'plan', { text: 'Add a step.', ...SUGGEST }, []],
    [
      'a plan suggestion of approve with blank words',
      'plan',
      { option_id: 'a', text: '  ', ...SUGGEST },
      [],
    ],
    [
      'a question suggestion of an option with words',
      'question',
      { option_id: 'a', text: 'Because.', ...SUGGEST },
      [],
    ],
  ])('%s', (_name, kind, input, findings) => {
    expect(checkHelpResult('suggest', OPTIONS, input, kind)).toEqual(findings)
  })
})

describe('resultOf', () => {
  it('keeps only the fields of the mode', () => {
    expect(resultOf('suggest', { option_id: 'b', ...SUGGEST })).toEqual({
      mode: 'suggest',
      option_id: 'b',
      ...SUGGEST,
    })
    expect(resultOf('explain', EXPLAIN)).toEqual({ mode: 'explain', ...EXPLAIN })
  })
})

describe('isCurrent', () => {
  it.each([
    ['open', 'needs_approval', null, true],
    ['expired on a blocked card', 'blocked', 'approval_expired', true],
    ['expired on a card that moved on', 'running', null, false],
    ['answered', 'running', null, false],
    ['withdrawn', 'failed', null, false],
  ])('%s', (status, taskState, blockCause, expected) => {
    const named = status.split(' ')[0] ?? status
    expect(isCurrent({ status: named, taskState, blockCause })).toBe(expected)
  })
})

describe('questionOf', () => {
  const approval = {
    kind: 'questions' as const,
    question: 'lead',
    context_md: null,
    options: [],
    recommendation: null,
    questions: [
      { id: 'q1', question: 'One', options: OPTIONS, recommendation: null, context_md: null },
    ],
  }
  it('finds a batch question by its index and refuses a missing one', () => {
    expect(questionOf(approval, 0)?.question).toBe('One')
    expect(questionOf(approval, 1)).toBeNull()
    expect(questionOf(approval, null)).toBeNull()
  })
  it('takes a single request whole, with no index', () => {
    const single = { ...approval, kind: 'question' as const, questions: null }
    expect(questionOf(single, null)?.question).toBe('lead')
    expect(questionOf(single, 0)).toBeNull()
  })
})

describe('hasInFlight and lostHelps', () => {
  it('sees a queued help of the same question and mode only', () => {
    const helps = [{ question_index: 1, mode: 'suggest' as const, status: 'queued' as const }]
    expect(hasInFlight(helps, 1, 'suggest')).toBe(true)
    expect(hasInFlight(helps, 1, 'explain')).toBe(false)
    expect(hasInFlight(helps, 0, 'suggest')).toBe(false)
  })
  it('loses a running help silent for more than 90 s', () => {
    const now = new Date('2026-10-20T12:00:00Z')
    const at = (s: number) => new Date(now.getTime() - s * 1000)
    expect(
      lostHelps(
        [
          { id: 'a', status: 'running', lastHeartbeatAt: at(91) },
          { id: 'b', status: 'running', lastHeartbeatAt: at(90) },
          { id: 'c', status: 'succeeded', lastHeartbeatAt: at(500) },
        ],
        now,
      ),
    ).toEqual(['a'])
  })
})

type ReviewFinding = {
  kind: string
  where?: string
  text: string
  choices?: string[]
  recommended?: number
  file?: string
  matters?: string
  destination?: string
  evidence?: string
}
const FACTS = { recommendable: [], checkedAgainst: 'latest_spec' }
const finding = (extra: Partial<ReviewFinding>): ReviewFinding => ({
  kind: 'missing',
  where: 'R1',
  text: 'X',
  destination: 'blocker',
  evidence: 'R1',
  ...extra,
})
const longChoice = 'x'.repeat(201)

describe('checkDecisionResult for review choices', () => {
  const rows: [string, Partial<ReviewFinding>, string[]][] = [
    ['2 choices, recommended 0', { choices: ['A', 'B'], recommended: 0 }, []],
    ['5 choices, recommended 4', { choices: ['A', 'B', 'C', 'D', 'E'], recommended: 4 }, []],
    ['1 choice', { choices: ['A'], recommended: 0 }, ['too_few']],
    ['6 choices', { choices: ['A', 'B', 'C', 'D', 'E', 'F'], recommended: 0 }, ['too_many']],
    ['a blank choice', { choices: ['A', ' '], recommended: 0 }, ['required']],
    ['a 201-character choice', { choices: ['A', longChoice], recommended: 0 }, ['too_long']],
    ['duplicate choices', { choices: ['A', ' A '], recommended: 0 }, ['duplicate']],
    ['recommended without choices', { recommended: 0 }, ['not_allowed']],
    ['choices without recommended', { choices: ['A', 'B'] }, ['required']],
    ['recommended past the end', { choices: ['A', 'B'], recommended: 2 }, ['unknown_choice']],
    ['recommended -1', { choices: ['A', 'B'], recommended: -1 }, ['unknown_choice']],
    ['recommended 0.5', { choices: ['A', 'B'], recommended: 0.5 }, ['unknown_choice']],
    ['neither field', {}, []],
  ]
  it.each(rows)('%s', (_name, extra, codes) => {
    const out = checkDecisionResult('review', { findings: [finding(extra)], unsure: 'u' }, FACTS)
    expect(out).toEqual(codes.map((code) => ({ field: 'findings', code })))
  })

  const codeRows: [string, Partial<ReviewFinding>][] = [
    ['choices', { choices: ['A', 'B'] }],
    ['recommended', { recommended: 0 }],
  ]
  it.each(codeRows)('refuses %s on a code_review finding', (_name, extra) => {
    const out = checkDecisionResult(
      'code_review',
      {
        findings: [
          {
            kind: 'bug',
            file: 'a.ts',
            text: 'T',
            matters: 'M',
            destination: 'blocker',
            evidence: 'a.ts:1',
            ...extra,
          },
        ],
        unsure: 'u',
        reasoning: 'r',
        next_step: 'fix_by_hand',
      },
      FACTS,
    )
    expect(out).toEqual([{ field: 'findings', code: 'not_allowed' }])
  })
})

describe('decisionResultOf for review choices', () => {
  const rows: [string, Partial<ReviewFinding>, Record<string, unknown>][] = [
    [
      'normalises whitespace',
      { choices: [' A\n  b ', 'C'], recommended: 1 },
      { choices: ['A b', 'C'], recommended: 1 },
    ],
    ['stores neither without choices', {}, {}],
  ]
  it.each(rows)('%s', (_name, extra, stored) => {
    const result = decisionResultOf('review', {
      findings: [finding(extra)],
      unsure: 'u',
    })
    expect(result).toMatchObject({
      findings: [{ kind: 'missing', where: 'R1', text: 'X', ...stored }],
    })
    if (Object.keys(stored).length === 0) {
      const first = (result as { findings: object[] }).findings[0]!
      expect('choices' in first).toBe(false)
      expect('recommended' in first).toBe(false)
    }
  })
})

const Q = (id: string, options = OPTIONS) => ({
  id,
  question: id,
  options,
  recommendation: null,
  context_md: null,
})
const BATCH = [Q('q1'), Q('q2', [{ id: 'x', label: 'X' }]), Q('q3')]
const OK = (id: string, change: Partial<BatchAnswerInput> = {}): BatchAnswerInput => ({
  question_id: id,
  option_id: id === 'q2' ? 'x' : 'a',
  reasoning: 'r',
  unsure: 'u',
  ...change,
})
const long = 'x'.repeat(4_001)

interface BatchRow {
  name: string
  answers: BatchAnswerInput[] | undefined
  other?: HelpResultInput
  /** `field:code` of the findings, empty when the result is saved. */
  expected: string[]
}
const batchRows: BatchRow[] = [
  { name: 'every question once', answers: [OK('q1'), OK('q2'), OK('q3')], expected: [] },
  { name: 'in another order', answers: [OK('q3'), OK('q1'), OK('q2')], expected: [] },
  { name: 'no answers at all', answers: undefined, expected: ['answers:required'] },
  { name: 'a missing q3', answers: [OK('q1'), OK('q2')], expected: ['answers:required'] },
  {
    name: 'an unknown q9',
    answers: [OK('q1'), OK('q2'), OK('q3'), OK('q9')],
    expected: ['answers:unknown_question'],
  },
  {
    name: 'a repeated q1',
    answers: [OK('q1'), OK('q1'), OK('q2'), OK('q3')],
    expected: ['answers:duplicate'],
  },
  {
    name: 'an option q2 does not offer',
    answers: [OK('q1'), OK('q2', { option_id: 'a' }), OK('q3')],
    expected: ['answers[1].option_id:unknown_option'],
  },
  {
    name: 'neither option nor words',
    answers: [OK('q1'), OK('q2'), OK('q3', { option_id: undefined })],
    expected: ['answers[2].option_id:required'],
  },
  {
    name: 'words alone',
    answers: [OK('q1'), OK('q2'), OK('q3', { option_id: undefined, text: 'Teal' })],
    expected: [],
  },
  {
    name: 'a blank reasoning',
    answers: [OK('q1', { reasoning: '  ' }), OK('q2'), OK('q3')],
    expected: ['answers[0].reasoning:required'],
  },
  {
    name: 'no unsure',
    answers: [OK('q1'), OK('q2'), OK('q3', { unsure: undefined })],
    expected: ['answers[2].unsure:required'],
  },
  {
    name: 'words over the limit',
    answers: [OK('q1', { text: long }), OK('q2'), OK('q3')],
    expected: ['answers[0].text:too_long'],
  },
  {
    name: 'an extra asked field',
    answers: [OK('q1'), OK('q2'), OK('q3')],
    other: { asked: 'q' },
    expected: ['asked:not_allowed'],
  },
  {
    name: 'a top-level reasoning',
    answers: [OK('q1'), OK('q2'), OK('q3')],
    other: { reasoning: 'r' },
    expected: ['reasoning:not_allowed'],
  },
]

describe('checkBatchResult', () => {
  it.each(batchRows)('$name', ({ answers, other, expected }) => {
    const findings = checkBatchResult(BATCH, { ...other, answers })
    expect(findings.map((f) => `${f.field}:${f.code}`)).toEqual(expected)
  })
})

describe('batchResultOf', () => {
  it('stores the answers in the batch order, trimmed', () => {
    const result = batchResultOf(BATCH, {
      answers: [
        OK('q3', { option_id: undefined, text: '  Teal ', reasoning: ' r ', unsure: ' u ' }),
        OK('q1'),
        OK('q2'),
      ],
    })
    expect(result).toEqual({
      mode: 'suggest_all',
      answers: [
        { question_id: 'q1', option_id: 'a', reasoning: 'r', unsure: 'u' },
        { question_id: 'q2', option_id: 'x', reasoning: 'r', unsure: 'u' },
        { question_id: 'q3', text: 'Teal', reasoning: 'r', unsure: 'u' },
      ],
    })
  })
})

describe('answers on a suggestion or an explanation', () => {
  it.each(['suggest', 'explain'] as const)('%s refuses answers', (mode) => {
    const input: HelpResultInput = {
      ...(mode === 'suggest' ? { option_id: 'a', ...SUGGEST } : EXPLAIN),
      answers: [OK('q1')],
    }
    expect(checkHelpResult(mode, OPTIONS, input)).toEqual([
      { field: 'answers', code: 'not_allowed' },
    ])
  })
})

describe('hasInFlight for the whole batch', () => {
  it('sees a running suggest_all help with no question index', () => {
    const helps = [
      { question_index: null, mode: 'suggest_all' as const, status: 'running' as const },
    ]
    expect(hasInFlight(helps, null, 'suggest_all')).toBe(true)
    expect(hasInFlight(helps, null, 'suggest')).toBe(false)
  })
})

describe('suggestRoute', () => {
  const flying = (status: 'queued' | 'running' | 'succeeded') => [
    { question_index: null, mode: 'suggest_all' as const, status },
  ]
  it.each<[string, Parameters<typeof suggestRoute>[0], string]>([
    ['a batch on whole', { kind: 'questions', setting: 'whole', helps: [] }, 'whole'],
    ['a batch on one', { kind: 'questions', setting: 'one', helps: [] }, 'one'],
    [
      'a batch with a queued whole help',
      { kind: 'questions', setting: 'one', helps: flying('queued') },
      'in_flight',
    ],
    [
      'a batch with a running whole help',
      { kind: 'questions', setting: 'whole', helps: flying('running') },
      'in_flight',
    ],
    [
      'a batch with a finished whole help',
      { kind: 'questions', setting: 'whole', helps: flying('succeeded') },
      'whole',
    ],
    ['a single question on whole', { kind: 'question', setting: 'whole', helps: [] }, 'one'],
    ['a plan on whole', { kind: 'plan', setting: 'whole', helps: [] }, 'one'],
  ])('%s', (_name, input, expected) => {
    expect(suggestRoute(input)).toBe(expected)
  })
})
