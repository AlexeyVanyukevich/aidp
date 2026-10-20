import { describe, expect, it } from 'vitest'
import {
  allowedFiles,
  checkAnswer,
  checkRequest,
  optionsFor,
  resumeMessage,
  type RequestInput,
} from '../../src/modules/approvals/approval-rules.js'

const A = { id: 'a', label: '3 retries, exponential backoff', impact: 'Matches the email worker' }
const B = { id: 'b', label: '5 retries, then dead-letter queue', impact: 'New DLQ table' }
const valid: RequestInput = { kind: 'question', question: 'How many retries?', options: [A, B] }
const option = (n: number) => ({ id: `o${n}`, label: `Option ${n}` })

describe('checkRequest', () => {
  it.each<[string, Partial<RequestInput>, { field: string; code: string }[]]>([
    ['a question with two options', {}, []],
    ['a question with no options: free text only', { options: [] }, []],
    ['five options', { options: [1, 2, 3, 4, 5].map(option) }, []],
    ['a recommendation naming an option', { recommendation: 'a' }, []],
    [
      'six options',
      { options: [1, 2, 3, 4, 5, 6].map(option) },
      [{ field: 'options', code: 'too_many' }],
    ],
    ['an empty question', { question: '   ' }, [{ field: 'question', code: 'required' }]],
    [
      'a question of 1 001 characters',
      { question: 'q'.repeat(1001) },
      [{ field: 'question', code: 'too_long' }],
    ],
    [
      'a label of 201 characters',
      { options: [{ id: 'a', label: 'l'.repeat(201) }] },
      [{ field: 'options[0].label', code: 'too_long' }],
    ],
    [
      'an empty label',
      { options: [{ id: 'a', label: '' }] },
      [{ field: 'options[0].label', code: 'required' }],
    ],
    [
      'an impact of 501 characters',
      { options: [{ id: 'a', label: 'l', impact: 'i'.repeat(501) }] },
      [{ field: 'options[0].impact', code: 'too_long' }],
    ],
    [
      'context of 8 001 characters',
      { context_md: 'c'.repeat(8001) },
      [{ field: 'context_md', code: 'too_long' }],
    ],
    [
      'a recommendation naming no option',
      { recommendation: 'z' },
      [{ field: 'recommendation', code: 'unknown_option' }],
    ],
    [
      'two options sharing an id',
      { options: [A, { ...B, id: 'a' }] },
      [{ field: 'options[1].id', code: 'duplicate' }],
    ],
    ['out of plan with a file', { kind: 'out_of_plan', options: [], files: ['src/a.ts'] }, []],
    [
      'out of plan recommending the server’s option',
      { kind: 'out_of_plan', options: [], files: ['src/a.ts'], recommendation: 'allow' },
      [],
    ],
    [
      'out of plan without files',
      { kind: 'out_of_plan', options: [] },
      [{ field: 'files', code: 'required' }],
    ],
    [
      'out of plan with 21 files',
      { kind: 'out_of_plan', options: [], files: Array.from({ length: 21 }, (_, n) => `f${n}.ts`) },
      [{ field: 'files', code: 'too_many' }],
    ],
    [
      'out of plan with an absolute path',
      { kind: 'out_of_plan', options: [], files: ['/etc/passwd'] },
      [{ field: 'files[0]', code: 'not_relative' }],
    ],
    [
      'out of plan leaving the worktree',
      { kind: 'out_of_plan', options: [], files: ['src/../../x.ts'] },
      [{ field: 'files[0]', code: 'not_relative' }],
    ],
  ])('%s', (_name, change, findings) => {
    expect(checkRequest({ ...valid, ...change })).toEqual(findings)
  })
})

describe('optionsFor', () => {
  it.each([
    ['question', [A, B], [A, B]],
    [
      'out_of_plan',
      [A],
      [
        { id: 'allow', label: 'Allow the change' },
        { id: 'refuse', label: 'Keep to the plan' },
      ],
    ],
    ['plan', [], [{ id: 'approve', label: 'Approve plan' }]],
  ] as const)('gives a %s request its options', (kind, agents, expected) => {
    expect(optionsFor(kind, [...agents])).toEqual(expected)
  })
})

describe('resumeMessage', () => {
  const files = ['src/a.ts', 'src/b.ts']
  it.each<
    [
      string,
      Parameters<typeof resumeMessage>[0],
      Parameters<typeof resumeMessage>[1],
      string | null,
    ]
  >([
    [
      'a question answered with an option',
      { kind: 'question', options: [A, B], files: null },
      { option_id: 'b' },
      'The owner answered your question:\n\n5 retries, then dead-letter queue — New DLQ table',
    ],
    [
      'a question answered with an option and words',
      { kind: 'question', options: [A, B], files: null },
      { option_id: 'a', text: 'Use jitter too.' },
      'The owner answered your question:\n\n3 retries, exponential backoff — Matches the email worker\n\nUse jitter too.',
    ],
    [
      'a question answered with an option that has no impact',
      { kind: 'question', options: [{ id: 'x', label: 'Red' }], files: null },
      { option_id: 'x' },
      'The owner answered your question:\n\nRed',
    ],
    [
      'a question answered in words',
      { kind: 'question', options: [A, B], files: null },
      { text: 'Use 4.' },
      'The owner answered your question:\n\nUse 4.',
    ],
    [
      'an out-of-plan change allowed',
      { kind: 'out_of_plan', options: optionsFor('out_of_plan', []), files },
      { option_id: 'allow' },
      'The owner allowed changes to: `src/a.ts`, `src/b.ts`.',
    ],
    [
      'an out-of-plan change refused, with a reason',
      { kind: 'out_of_plan', options: optionsFor('out_of_plan', []), files: ['src/a.ts'] },
      { option_id: 'refuse', text: 'Put it in the existing module.' },
      'The owner kept to the plan. Do not change: `src/a.ts`.\n\nPut it in the existing module.',
    ],
    [
      'an out-of-plan change answered only in words, which allows nothing',
      { kind: 'out_of_plan', options: optionsFor('out_of_plan', []), files: ['src/a.ts'] },
      { text: 'Ask me again after the tests pass.' },
      'The owner answered your request to change `src/a.ts`:\n\nAsk me again after the tests pass.',
    ],
    [
      'a plan sent back with changes',
      { kind: 'plan', options: optionsFor('plan', []), files: null },
      { text: 'Split step 2.' },
      'The owner asked for changes to the plan:\n\nSplit step 2.\n\nSave the revised plan with save_plan.',
    ],
    [
      'a plan approved: Build starts, no session resumes',
      { kind: 'plan', options: optionsFor('plan', []), files: null },
      { option_id: 'approve' },
      null,
    ],
  ])('%s', (_name, approval, answer, expected) => {
    expect(resumeMessage(approval, answer)).toBe(expected)
  })
})

describe('allowedFiles', () => {
  const allow = (f: string[]) => ({
    kind: 'out_of_plan' as const,
    files: f,
    answer: { option_id: 'allow' },
  })
  it.each<[string, string[], Parameters<typeof allowedFiles>[1], string[]]>([
    ['the plan alone', ['src/a.ts'], [], ['src/a.ts']],
    ['with one allowed change', ['src/a.ts'], [allow(['src/b.ts'])], ['src/a.ts', 'src/b.ts']],
    [
      'without repeating a file',
      ['src/a.ts'],
      [allow(['src/a.ts', 'src/c.ts']), allow(['src/c.ts'])],
      ['src/a.ts', 'src/c.ts'],
    ],
    [
      'a refused change adds nothing',
      ['src/a.ts'],
      [{ kind: 'out_of_plan', files: ['src/x.ts'], answer: { option_id: 'refuse' } }],
      ['src/a.ts'],
    ],
    [
      'an answer in words alone adds nothing',
      ['src/a.ts'],
      [{ kind: 'out_of_plan', files: ['src/x.ts'], answer: { text: 'later' } }],
      ['src/a.ts'],
    ],
    [
      'other kinds add nothing',
      ['src/a.ts'],
      [{ kind: 'question', files: null, answer: { option_id: 'allow' } }],
      ['src/a.ts'],
    ],
  ])('%s', (_name, plan, answered, expected) => {
    expect(allowedFiles(plan, answered)).toEqual(expected)
  })
})

describe('checkAnswer', () => {
  it.each<[string, Parameters<typeof checkAnswer>[1], { field: string; code: string }[]]>([
    ['an option', { option_id: 'a' }, []],
    ['words', { text: 'Use 4' }, []],
    ['both', { option_id: 'b', text: 'and jitter' }, []],
    ['neither', {}, [{ field: 'text', code: 'required' }]],
    ['blank words', { text: '  ' }, [{ field: 'text', code: 'required' }]],
    [
      'an option the request does not offer',
      { option_id: 'zz' },
      [{ field: 'option_id', code: 'unknown_option' }],
    ],
    [
      'words over 4 000 characters',
      { text: 'x'.repeat(4001) },
      [{ field: 'text', code: 'too_long' }],
    ],
  ])('%s', (_name, answer, findings) => {
    expect(checkAnswer({ options: [A, B] }, answer)).toEqual(findings)
  })
})
