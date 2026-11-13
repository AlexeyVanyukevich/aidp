import { describe, expect, it } from 'vitest'
import {
  checkDecisionResult,
  checkHelpResult,
  decisionResultOf,
  hasInFlight,
  isCurrent,
  lostHelps,
  questionOf,
  resultOf,
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
}
const FACTS = { recommendable: [], checkedAgainst: 'latest_spec' }
const finding = (extra: Partial<ReviewFinding>): ReviewFinding => ({
  kind: 'missing',
  where: 'R1',
  text: 'X',
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
    const out = checkDecisionResult(
      'review',
      { verdict: 'changes', findings: [finding(extra)], unsure: 'u' },
      FACTS,
    )
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
        verdict: 'changes',
        findings: [{ kind: 'bug', file: 'a.ts', text: 'T', matters: 'M', ...extra }],
        unsure: 'u',
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
      verdict: 'changes',
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
