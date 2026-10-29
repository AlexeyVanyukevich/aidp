import { describe, expect, it } from 'vitest'
import { parseSpec } from '../../src/modules/specs/spec-parser.js'

const GOOD = `# Spec: Retry webhooks (PAY-42 · v1)

## Goal
Failed webhook deliveries are retried.

## Requirements
1. R1 – A failed delivery is retried with exponential backoff
2. R2 – After the last retry the delivery is marked dead

## Acceptance criteria
- AC1 (R1): Given a 500 When delivering Then it is retried after 1s, 2s and 4s
- AC2 (R2): Given four failures When the last fails Then the delivery is dead

## Open questions
`

describe('parseSpec on the template', () => {
  it('reads requirements, criteria and no open questions', () => {
    const spec = parseSpec(GOOD)
    expect(spec.requirements.map((r) => r.id)).toEqual(['R1', 'R2'])
    expect(spec.criteria).toEqual([
      {
        id: 'AC1',
        requirements: ['R1'],
        text: 'Given a 500 When delivering Then it is retried after 1s, 2s and 4s',
        owner: false,
      },
      {
        id: 'AC2',
        requirements: ['R2'],
        text: 'Given four failures When the last fails Then the delivery is dead',
        owner: false,
      },
    ])
    expect(spec.openQuestions).toEqual([])
    expect(spec.findings).toEqual([])
    expect(spec.approvable).toBe(true)
  })
})

/** Review Focus 1: a spec written elsewhere lints exactly like the template. */
describe('parseSpec on the same spec written differently', () => {
  it.each([
    ['CRLF line endings', GOOD.replaceAll('\n', '\r\n')],
    [
      'lower-case headings',
      GOOD.replace('## Acceptance criteria', '## acceptance criteria').replace(
        '## Requirements',
        '## requirements',
      ),
    ],
    ['star bullets', GOOD.replaceAll('- AC', '* AC')],
    ['a colon after the requirement id', GOOD.replace('R1 –', 'R1:').replace('R2 –', 'R2:')],
    ['a hyphen after the requirement id', GOOD.replace('R1 –', 'R1 -').replace('R2 –', 'R2 -')],
    [
      'bullets instead of numbers for requirements',
      GOOD.replace('1. R1', '- R1').replace('2. R2', '- R2'),
    ],
    ['trailing spaces', GOOD.replaceAll('\n', '   \n')],
  ])('%s', (_name, text) => {
    const spec = parseSpec(text)
    expect(spec.findings).toEqual([])
    expect(spec.requirements.map((r) => r.id)).toEqual(['R1', 'R2'])
    expect(spec.criteria.map((c) => c.id)).toEqual(['AC1', 'AC2'])
    expect(spec.approvable).toBe(true)
  })
})

describe('the lint', () => {
  it.each([
    [
      'a requirement without a criterion',
      GOOD.replace(/- AC2.*\n/, ''),
      [{ code: 'requirement_without_criterion', id: 'R2' }],
    ],
    [
      'a criterion naming a requirement that does not exist',
      GOOD.replace('AC2 (R2)', 'AC2 (R2, R9)'),
      [{ code: 'unknown_requirement', id: 'AC2', text: 'R9' }],
    ],
    [
      'a repeated requirement id',
      GOOD.replace('2. R2', '2. R1').replace('AC2 (R2)', 'AC2 (R1)'),
      [{ code: 'duplicate_id', id: 'R1' }],
    ],
    [
      'a criterion that names no requirement',
      GOOD.replace('AC2 (R2):', 'AC2 ():'),
      [
        { code: 'criterion_without_requirement', id: 'AC2' },
        { code: 'requirement_without_criterion', id: 'R2' },
      ],
    ],
    [
      'a requirement without an id',
      GOOD.replace('2. R2 – After', '2. After'),
      [
        {
          code: 'requirement_without_id',
          text: 'After the last retry the delivery is marked dead',
        },
        { code: 'unknown_requirement', id: 'AC2', text: 'R2' },
      ],
    ],
    [
      'a criterion without an id',
      GOOD.replace('- AC2 (R2): Given', '- Given'),
      [
        {
          code: 'criterion_without_id',
          text: 'Given four failures When the last fails Then the delivery is dead',
        },
        { code: 'requirement_without_criterion', id: 'R2' },
      ],
    ],
    [
      'no requirements section',
      GOOD.replace(/## Requirements[\s\S]*?(?=## Acceptance)/, ''),
      [
        { code: 'no_requirements' },
        { code: 'unknown_requirement', id: 'AC1', text: 'R1' },
        { code: 'unknown_requirement', id: 'AC2', text: 'R2' },
      ],
    ],
  ])('reports %s', (_name, text, findings) => {
    const spec = parseSpec(text)
    expect(spec.findings).toEqual(findings)
    expect(spec.approvable).toBe(false)
  })

  it('reads every criterion a requirement list names', () => {
    const spec = parseSpec(GOOD.replace('AC2 (R2)', 'AC2 (R1, R2)'))
    expect(spec.criteria[1]?.requirements).toEqual(['R1', 'R2'])
  })

  it('counts open questions and refuses approval while any remain', () => {
    const spec = parseSpec(`${GOOD}- Should a dead delivery alert anyone?\n- \n`)
    expect(spec.openQuestions).toEqual(['Should a dead delivery alert anyone?'])
    expect(spec.findings).toEqual([])
    expect(spec.approvable).toBe(false)
  })
})

const REQS = '## Requirements\n1. R1 – a\n\n## Acceptance criteria\n- AC1 (R1): Given x Then y\n\n'

interface Row {
  name: string
  body: string
  questions: string[]
  approvable: boolean
}

const QUESTION_ROWS: Row[] = [
  {
    name: 'AC1 a plain line',
    body: `${REQS}## Open questions\nShell cwd was reset to /tmp/x\n`,
    questions: ['Shell cwd was reset to /tmp/x'],
    approvable: false,
  },
  {
    name: 'AC2 an indented line after an item',
    body: `${REQS}## Open questions\n- Should a dead delivery alert anyone?\n  It matters for on-call.\n`,
    questions: ['Should a dead delivery alert anyone?', 'It matters for on-call.'],
    approvable: false,
  },
  {
    name: 'AC3 blanks, spaces and bare markers',
    body: `${REQS}## Open questions\n\n   \n-\n- \n*\n+\n1.\n1)\n`,
    questions: [],
    approvable: true,
  },
  {
    name: 'AC4 None',
    body: `${REQS}## Open questions\nNone\n`,
    questions: ['None'],
    approvable: false,
  },
  {
    name: 'AC4 None.',
    body: `${REQS}## Open questions\nNone.\n`,
    questions: ['None.'],
    approvable: false,
  },
  {
    name: 'AC4 N/A',
    body: `${REQS}## Open questions\nN/A\n`,
    questions: ['N/A'],
    approvable: false,
  },
  {
    name: 'AC4 - None',
    body: `${REQS}## Open questions\n- None\n`,
    questions: ['None'],
    approvable: false,
  },
  {
    name: 'AC5 order',
    body: `${REQS}## Open questions\nFirst\n- Second\nThird\n`,
    questions: ['First', 'Second', 'Third'],
    approvable: false,
  },
  {
    name: 'AC6 a repeated empty section',
    body: `${REQS}## Open questions\n- Is one second right?\n\n## Open questions\n`,
    questions: ['Is one second right?'],
    approvable: false,
  },
]

describe('parseSpec on Open questions', () => {
  it.each(QUESTION_ROWS)('$name', ({ body, questions, approvable }) => {
    const spec = parseSpec(body)
    expect(spec.openQuestions).toEqual(questions)
    expect(spec.findings).toEqual([])
    expect(spec.approvable).toBe(approvable)
  })
})

describe('parseSpec on a repeated heading', () => {
  it('AC7 reads both sections as one', () => {
    const spec = parseSpec(
      '## Requirements\n1. R1 – a\n\n## Requirements\n2. R2 – b\n\n## Acceptance criteria\n- AC1 (R1): Given x Then y\n- AC2 (R2): Given x Then y\n',
    )
    expect(spec.requirements.map((r) => r.id)).toEqual(['R1', 'R2'])
    expect(spec.findings).toEqual([])
  })

  it('AC8 reports an id repeated across sections', () => {
    const spec = parseSpec(
      '## Requirements\n1. R1 – a\n\n## Requirements\n2. R1 – b\n\n## Acceptance criteria\n- AC1 (R1): Given x Then y\n',
    )
    expect(spec.findings).toContainEqual({ code: 'duplicate_id', id: 'R1' })
  })
})

const CASES: {
  marks: string
  requirements: string[]
  owner: boolean
  findings: { code: string; text?: string }[]
}[] = [
  { marks: '(R1)', requirements: ['R1'], owner: false, findings: [] },
  { marks: '(R1, owner)', requirements: ['R1'], owner: true, findings: [] },
  { marks: '(R1 owner)', requirements: ['R1'], owner: true, findings: [] },
  { marks: '(owner, R1, R2)', requirements: ['R1', 'R2'], owner: true, findings: [] },
  {
    marks: '(R1, Owner)',
    requirements: ['R1'],
    owner: false,
    findings: [{ code: 'unknown_marker', text: 'Owner' }],
  },
  {
    marks: '(R1, ownr)',
    requirements: ['R1'],
    owner: false,
    findings: [{ code: 'unknown_marker', text: 'ownr' }],
  },
  {
    marks: '(owner)',
    requirements: [],
    owner: true,
    findings: [{ code: 'criterion_without_requirement' }],
  },
  { marks: '(R1, )', requirements: ['R1'], owner: false, findings: [] },
  { marks: '( R1)', requirements: ['R1'], owner: false, findings: [] },
  {
    marks: '(r1)',
    requirements: [],
    owner: false,
    findings: [{ code: 'criterion_without_requirement' }, { code: 'unknown_marker', text: 'r1' }],
  },
]

describe('parseSpec on the owner marker', () => {
  it.each(CASES)('reads $marks', ({ marks, requirements, owner, findings }) => {
    const spec = parseSpec(
      `## Requirements\n1. R1 – a\n2. R2 – b\n\n## Acceptance criteria\n- AC1 ${marks}: Given x When y Then z\n- AC2 (R2): Given x When y Then z\n`,
    )
    const own = spec.criteria.find((c) => c.id === 'AC1')
    expect(own?.requirements).toEqual(requirements)
    expect(own?.owner).toBe(owner)
    const named = spec.findings.filter((f) => f.id === 'AC1')
    expect(named.map(({ code, text }) => (text === undefined ? { code } : { code, text }))).toEqual(
      findings,
    )
    expect(spec.findings.some((f) => f.code === 'unknown_requirement')).toBe(false)
  })

  const withMarks = (marks: string) =>
    `## Requirements\n1. R1 – a\n\n## Acceptance criteria\n- AC1 ${marks}: Given x When y Then z\n\n## Open questions\n`

  it.each([
    ['(R1, Owner)', false],
    ['(R1, owner)', true],
  ])('approvable for %s is %s', (marks, approvable) => {
    expect(parseSpec(withMarks(marks)).approvable).toBe(approvable)
  })
})

const AC = '## Acceptance criteria\n- AC1 (R1): Given x Then y\n'
const PROSE = (section: string, text: string) => ({ code: 'prose_in_list', section, text })

const PROSE_ROWS: { name: string; body: string; findings: object[] }[] = [
  {
    name: 'AC1 a line after an item',
    body: `## Requirements\n1. R1 – first\nThe export must also include archived rows.\n\n${AC}`,
    findings: [PROSE('Requirements', 'The export must also include archived rows.')],
  },
  {
    name: 'AC2 prose under other sections',
    body: '## Requirements\nEach is testable:\n1. R1 – a\n\n## Acceptance criteria\nEach names its requirement:\n- AC1 (R1): Given x Then y\n',
    findings: [
      PROSE('Requirements', 'Each is testable:'),
      PROSE('Acceptance criteria', 'Each names its requirement:'),
    ],
  },
  {
    name: 'AC3 a fenced block at column 0',
    body: `## Requirements\n1. R1 – a\n\n\`\`\`json\n{ "a": 1 }\n\`\`\`\n\n${AC}`,
    findings: [
      PROSE('Requirements', '```json'),
      PROSE('Requirements', '{ "a": 1 }'),
      PROSE('Requirements', '```'),
    ],
  },
  {
    name: 'AC8 an indented line with nothing above',
    body: `## Requirements\n   indented with nothing above\n1. R1 – a\n\n${AC}`,
    findings: [PROSE('Requirements', 'indented with nothing above')],
  },
  {
    name: 'AC9 an indented line under a repeated heading',
    body: `## Requirements\n1. R1 – a\n\n## Requirements\n   b\n\n${AC}`,
    findings: [PROSE('Requirements', 'b')],
  },
  {
    name: 'AC12 only prose under Requirements',
    body: `## Requirements\nThe export must include archived rows.\n\n${AC}`,
    findings: [
      { code: 'no_requirements' },
      PROSE('Requirements', 'The export must include archived rows.'),
      { code: 'unknown_requirement', id: 'AC1', text: 'R1' },
    ],
  },
  {
    name: 'AC13 prose between requirements',
    body: '## Requirements\n1. R1 – a\nmiddle\n2. R2 – b\n\n## Acceptance criteria\n- AC1 (R1): Given x\n- AC2 (R2): Given x\n',
    findings: [PROSE('Requirements', 'middle')],
  },
  {
    name: 'AC14 findings in the order of the lines',
    body: '## Requirements\n- first without id\nbetween\n- second without id\n1. R1 – a\n\n## Acceptance criteria\n- criterion without id\nafter it\n- AC1 (R1): Given x Then y\n',
    findings: [
      { code: 'requirement_without_id', text: 'first without id' },
      PROSE('Requirements', 'between'),
      { code: 'requirement_without_id', text: 'second without id' },
      { code: 'criterion_without_id', text: 'criterion without id' },
      PROSE('Acceptance criteria', 'after it'),
    ],
  },
]

describe('parseSpec on prose under Requirements and Acceptance criteria', () => {
  it.each(PROSE_ROWS)('$name', ({ body, findings }) => {
    const spec = parseSpec(body)
    expect(spec.findings).toEqual(findings)
    expect(spec.approvable).toBe(false)
  })

  it('AC12 reads no requirement from prose', () => {
    expect(parseSpec(PROSE_ROWS[5]?.body ?? '').requirements).toEqual([])
  })

  it('AC13 keeps both requirements around prose', () => {
    expect(parseSpec(PROSE_ROWS[6]?.body ?? '').requirements.map((r) => r.id)).toEqual(['R1', 'R2'])
  })

  it('AC9 keeps R1 text', () => {
    expect(parseSpec(PROSE_ROWS[4]?.body ?? '').requirements).toEqual([{ id: 'R1', text: 'a' }])
  })

  it('AC4 ignores blanks and bare markers', () => {
    const spec = parseSpec(
      '## Requirements\n\n   \n\t\n-\n*\n+\n1.\n1)\n1. R1 – a\n\n## Acceptance criteria\n\n \n-\n*\n+\n1.\n1)\n- AC1 (R1): Given x Then y\n',
    )
    expect(spec.findings).toEqual([])
    expect(spec.approvable).toBe(true)
  })
})

describe('parseSpec on continuation lines', () => {
  it('AC5 joins an indented line to its criterion', () => {
    const spec = parseSpec(
      `## Requirements\n1. R1 – a\n\n## Acceptance criteria\n- AC1 (R1): Given x\n  When y Then z\n`,
    )
    expect(spec.criteria).toEqual([
      { id: 'AC1', requirements: ['R1'], text: 'Given x\n  When y Then z', owner: false },
    ])
    expect(spec.findings).toEqual([])
  })

  it('AC6 keeps nested list lines in a requirement', () => {
    const spec = parseSpec(
      `## Requirements\n1. R1 – runs these commands:\n\n   - npm test\n   - npm run lint\n\n${AC}`,
    )
    expect(spec.requirements).toEqual([
      { id: 'R1', text: 'runs these commands:\n   - npm test\n   - npm run lint' },
    ])
    expect(spec.findings).toEqual([])
  })

  it('AC7 keeps a tab', () => {
    const spec = parseSpec(
      `## Requirements\n1. R1 – a\n\n## Acceptance criteria\n- AC1 (R1): Given x\n\tWhen y Then z\n`,
    )
    expect(spec.criteria[0]?.text).toBe('Given x\n\tWhen y Then z')
    expect(spec.findings).toEqual([])
  })

  it('AC10 reads parentheses from the first line only', () => {
    const spec = parseSpec(
      '## Requirements\n1. R1 – a\n2. R2 – b\n\n## Acceptance criteria\n- AC1 (R1): Given x\n  (R2) Then y\n- AC2 (R2): Given x\n',
    )
    expect(spec.criteria[0]?.requirements).toEqual(['R1'])
    expect(spec.findings).toEqual([])
  })
})
