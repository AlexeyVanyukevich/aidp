import { describe, expect, it } from 'vitest'
import {
  allowedFiles,
  approvedMigrations,
  checkAnswer,
  checkBatchAnswer,
  checkRequest,
  LIMITS,
  leadLine,
  numberQuestions,
  optionsFor,
  questionCount,
  resumeMessage,
  type BatchQuestion,
  type BatchQuestionInput,
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

  describe('a migration request', () => {
    const M = 'server/src/db/migrations/004_x.ts'
    const ok = { kind: 'migration' as const, options: [], files: [M], context_md: 'code' }
    it.each<[string, Record<string, unknown>, unknown[]]>([
      ['valid', {}, []],
      ['with 20,000 characters of code', { context_md: 'x'.repeat(20_000) }, []],
      ['no files', { files: undefined }, [{ field: 'files', code: 'required' }]],
      ['two files', { files: [M, 'a/migrations/b.ts'] }, [{ field: 'files', code: 'too_many' }]],
      ['an absolute path', { files: ['/etc/x'] }, [{ field: 'files[0]', code: 'not_relative' }]],
      ['a blank question', { question: '  ' }, [{ field: 'question', code: 'required' }]],
      [
        'a question over 1,000',
        { question: 'q'.repeat(1_001) },
        [{ field: 'question', code: 'too_long' }],
      ],
      ['blank code', { context_md: ' \n' }, [{ field: 'context_md', code: 'required' }]],
      ['no code', { context_md: undefined }, [{ field: 'context_md', code: 'required' }]],
      [
        'code over 20,000',
        { context_md: 'x'.repeat(20_001) },
        [{ field: 'context_md', code: 'too_long' }],
      ],
    ])('%s', (_name, change, findings) => {
      expect(checkRequest({ ...valid, ...ok, ...change })).toEqual(findings)
    })
    it('keeps 8,000 for another kind', () => {
      expect(checkRequest({ ...valid, context_md: 'x'.repeat(8_001) })).toEqual([
        { field: 'context_md', code: 'too_long' },
      ])
    })
    it('offers fixed options and writes its resume messages', () => {
      const options = optionsFor('migration', [A])
      expect(options).toEqual([
        { id: 'allow', label: 'Allow the migration' },
        { id: 'refuse', label: 'Keep to the plan' },
      ])
      const approval = { kind: 'migration' as const, options, files: [M] }
      expect(resumeMessage(approval, { option_id: 'allow', text: 'Go.' })).toBe(
        `The owner allowed the migration \`${M}\`.\n\nGo.`,
      )
      expect(resumeMessage(approval, { option_id: 'refuse' })).toMatch(
        /Do not create or change `[^`]+`\. Finish without it, and say in your report that the migration is needed\.$/,
      )
      expect(resumeMessage(approval, { text: 'Wait.' })).toBe(
        `The owner answered your request for the migration \`${M}\`:\n\nWait.`,
      )
    })
    it('lists approved migrations, only the allowed ones', () => {
      expect(
        approvedMigrations([
          { kind: 'migration', files: [M], answer: { option_id: 'allow' } },
          { kind: 'migration', files: ['b/migrations/x.ts'], answer: { option_id: 'refuse' } },
          { kind: 'out_of_plan', files: ['c.ts'], answer: { option_id: 'allow' } },
        ]),
      ).toEqual([M])
    })
  })
})

describe('checkRequest for a migration out of order', () => {
  const DIR = 'server/src/db/migrations'
  const request = (file: string) => ({
    kind: 'migration' as const,
    question: 'Adds a column.',
    options: [],
    files: [`${DIR}/${file}`],
    context_md: 'code',
  })
  const siblings = ['004_setup_command.ts', '005_plan_kept_from.ts', '006_project_links.ts']
  it('names the sibling a new name must sort after', () => {
    expect(checkRequest(request('004_helps.ts'), { exists: false, siblings })).toEqual([
      { field: 'files[0]', code: 'out_of_order', after: '006_project_links' },
    ])
  })
  it.each([
    ['a name in order', '007_helps.ts', false],
    ['an existing path', '004_setup_command.ts', true],
  ])('raises nothing for %s', (_name, file, exists) => {
    expect(checkRequest(request(file), { exists, siblings })).toEqual([])
  })
  it('raises nothing when no siblings were read', () => {
    expect(checkRequest(request('001_initial.ts'), { exists: false, siblings: [] })).toEqual([])
    expect(checkRequest(request('004_helps.ts'))).toEqual([])
  })
})

describe('checkRequest for a plan', () => {
  const plan = (length: number): RequestInput => ({
    kind: 'plan',
    question: 'Approve this plan?',
    options: [],
    context_md: 'c'.repeat(length),
  })

  it('shares one limit of 20 000 characters', () => {
    expect(LIMITS.planContext).toBe(20_000)
  })
  it('accepts 20 000 characters of context', () => {
    expect(checkRequest(plan(20_000))).toEqual([])
  })
  it('refuses 20 001 characters of context', () => {
    expect(checkRequest(plan(20_001))).toEqual([{ field: 'context_md', code: 'too_long' }])
  })
  it.each(['question', 'out_of_plan'] as const)('keeps %s at 8 000 characters', (kind) => {
    const request: RequestInput = {
      ...valid,
      kind,
      files: ['a.ts'],
      context_md: 'c'.repeat(8001),
    }
    expect(checkRequest(request)).toEqual([{ field: 'context_md', code: 'too_long' }])
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

// Slice 3: a batch of questions, asked together and answered whole (slice 3 spec, §6).
const HOW_OFTEN: BatchQuestionInput = {
  question: 'How often?',
  options: [A, B],
  recommendation: 'a',
  context_md: 'Today it never retries.',
}
const WHICH: BatchQuestionInput = { question: 'Which errors?' }
const batch = (questions: BatchQuestionInput[], change: Partial<RequestInput> = {}) =>
  checkRequest({ kind: 'questions', question: '', options: [], questions, ...change })

describe('checkRequest for a batch', () => {
  it.each<[string, BatchQuestionInput[], Partial<RequestInput>, { field: string; code: string }[]]>(
    [
      ['two questions, no lead line', [HOW_OFTEN, WHICH], {}, []],
      ['a lead line', [WHICH], { question: 'Before the spec' }, []],
      ['eight questions', Array.from({ length: 8 }, () => WHICH), {}, []],
      ['no question at all', [], {}, [{ field: 'questions', code: 'required' }]],
      [
        'nine questions',
        Array.from({ length: 9 }, () => WHICH),
        {},
        [{ field: 'questions', code: 'too_many' }],
      ],
      [
        'an empty question',
        [WHICH, { question: ' ' }],
        {},
        [{ field: 'questions[1].question', code: 'required' }],
      ],
      [
        'a question of 1 001 characters',
        [{ question: 'q'.repeat(1001) }],
        {},
        [{ field: 'questions[0].question', code: 'too_long' }],
      ],
      [
        'six options on one question',
        [{ question: 'Which?', options: [1, 2, 3, 4, 5, 6].map(option) }],
        {},
        [{ field: 'questions[0].options', code: 'too_many' }],
      ],
      [
        'an empty label',
        [{ question: 'Which?', options: [{ id: 'a', label: '' }] }],
        {},
        [{ field: 'questions[0].options[0].label', code: 'required' }],
      ],
      [
        'two options sharing an id',
        [{ question: 'Which?', options: [A, { ...B, id: 'a' }] }],
        {},
        [{ field: 'questions[0].options[1].id', code: 'duplicate' }],
      ],
      [
        'a recommendation naming no option of its question',
        [WHICH, { ...HOW_OFTEN, recommendation: 'z' }],
        {},
        [{ field: 'questions[1].recommendation', code: 'unknown_option' }],
      ],
      [
        'a question’s context of 2 001 characters',
        [{ question: 'Which?', context_md: 'c'.repeat(2001) }],
        {},
        [{ field: 'questions[0].context_md', code: 'too_long' }],
      ],
      [
        'shared context of 8 001 characters',
        [WHICH],
        { context_md: 'c'.repeat(8001) },
        [{ field: 'context_md', code: 'too_long' }],
      ],
      [
        'a lead line of 1 001 characters',
        [WHICH],
        { question: 'q'.repeat(1001) },
        [{ field: 'question', code: 'too_long' }],
      ],
    ],
  )('%s', (_name, questions, change, findings) => {
    expect(batch(questions, change)).toEqual(findings)
  })
})

describe('numberQuestions', () => {
  it('numbers the questions in their order, and fills what the agent left out', () => {
    expect(numberQuestions([HOW_OFTEN, WHICH])).toEqual([
      {
        id: 'q1',
        question: 'How often?',
        options: [A, B],
        recommendation: 'a',
        context_md: 'Today it never retries.',
      },
      { id: 'q2', question: 'Which errors?', options: [], recommendation: null, context_md: null },
    ])
  })

  it.each([
    [1, '1 question about the spec'],
    [3, '3 questions about the spec'],
  ])('gives %i questions the lead line "%s"', (count, line) => {
    expect(leadLine(count)).toBe(line)
  })
})

const NUMBERED: BatchQuestion[] = numberQuestions([HOW_OFTEN, WHICH])

describe('checkBatchAnswer', () => {
  it.each<[string, Parameters<typeof checkBatchAnswer>[1], { field: string; code: string }[]]>([
    [
      'every question, by option and by words',
      {
        answers: [
          { question_id: 'q1', option_id: 'b' },
          { question_id: 'q2', text: 'Only 5xx' },
        ],
      },
      [],
    ],
    [
      'both an option and words',
      {
        answers: [
          { question_id: 'q1', option_id: 'a', text: 'and jitter' },
          { question_id: 'q2', text: 'All' },
        ],
      },
      [],
    ],
    [
      'answers in another order',
      {
        answers: [
          { question_id: 'q2', text: 'All' },
          { question_id: 'q1', option_id: 'a' },
        ],
      },
      [],
    ],
    [
      'a question left out',
      { answers: [{ question_id: 'q1', option_id: 'a' }] },
      [{ field: 'answers[1]', code: 'required' }],
    ],
    [
      'a question answered with blank words',
      {
        answers: [
          { question_id: 'q1', option_id: 'a' },
          { question_id: 'q2', text: '  ' },
        ],
      },
      [{ field: 'answers[1]', code: 'required' }],
    ],
    [
      'an option its question does not offer',
      {
        answers: [
          { question_id: 'q1', option_id: 'zz' },
          { question_id: 'q2', text: 'All' },
        ],
      },
      [{ field: 'answers[0].option_id', code: 'unknown_option' }],
    ],
    [
      'words over 4 000 characters',
      {
        answers: [
          { question_id: 'q1', option_id: 'a' },
          { question_id: 'q2', text: 'x'.repeat(4001) },
        ],
      },
      [{ field: 'answers[1].text', code: 'too_long' }],
    ],
    [
      'a question the batch does not have',
      {
        answers: [
          { question_id: 'q1', option_id: 'a' },
          { question_id: 'q2', text: 'All' },
          { question_id: 'q9', text: 'Extra' },
        ],
      },
      [{ field: 'answers', code: 'unknown_question' }],
    ],
    [
      'a question answered twice',
      {
        answers: [
          { question_id: 'q1', option_id: 'a' },
          { question_id: 'q1', option_id: 'b' },
          { question_id: 'q2', text: 'All' },
        ],
      },
      [{ field: 'answers', code: 'duplicate' }],
    ],
  ])('%s', (_name, answer, findings) => {
    expect(checkBatchAnswer(NUMBERED, answer)).toEqual(findings)
  })
})

describe('resumeMessage for a batch', () => {
  it('lists each question with its answer, in the batch’s order', () => {
    expect(
      resumeMessage(
        { kind: 'questions', options: [], files: null, questions: NUMBERED },
        {
          answers: [
            { question_id: 'q2', text: 'Only 5xx.\nNever 4xx.' },
            { question_id: 'q1', option_id: 'a', text: 'Add jitter.' },
          ],
        },
      ),
    ).toBe(
      [
        'The owner answered your questions:',
        '',
        '1. How often?',
        '   3 retries, exponential backoff — Matches the email worker',
        '   Add jitter.',
        '',
        '2. Which errors?',
        '   Only 5xx.',
        '   Never 4xx.',
      ].join('\n'),
    )
  })
})

describe('questionCount', () => {
  it.each<[string, Parameters<typeof questionCount>[0], number]>([
    ['a single question', { kind: 'question', questions: null }, 1],
    ['a plan', { kind: 'plan', questions: null }, 1],
    ['a batch of two', { kind: 'questions', questions: NUMBERED }, 2],
  ])('%s counts %i', (_name, approval, count) => {
    expect(questionCount(approval)).toBe(count)
  })
})
