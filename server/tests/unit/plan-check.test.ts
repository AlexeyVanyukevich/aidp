import { describe, expect, it } from 'vitest'
import {
  checkPlan,
  checkReport,
  planFiles,
  renderPlan,
  renderReport,
  type PlanInput,
} from '../../src/modules/mcp/plan-check.js'

const SPEC = {
  requirements: ['R1', 'R2'],
  criteria: [
    { id: 'AC1', requirements: ['R1'], text: 'a' },
    { id: 'AC2', requirements: ['R2'], text: 'b' },
  ],
}
const PLAN: PlanInput = {
  summary: 'Two steps',
  confidence: 'high',
  steps: [
    {
      title: 'Backoff',
      requirements: ['R1'],
      files: ['src/retry.ts', 'src/retry.test.ts'],
      estimate_usd: 0.4,
    },
    { title: 'Dead letters', requirements: ['R2'], files: ['src/retry.ts'] },
  ],
  checks: [
    { criterion: 'AC1', how: 'unit test of the delays' },
    { criterion: 'AC2', how: 'unit test of the fourth failure' },
  ],
}

describe('checkPlan', () => {
  it('accepts a plan that maps every step and every criterion', () => {
    expect(checkPlan(PLAN, SPEC)).toEqual([])
  })

  it.each([
    [
      'a step naming an unknown requirement',
      { ...PLAN, steps: [{ ...PLAN.steps[0]!, requirements: ['R9'] }, PLAN.steps[1]!] },
      [{ code: 'unknown_requirement', step: 1, id: 'R9' }],
    ],
    [
      'a criterion without a check',
      { ...PLAN, checks: [PLAN.checks[0]!] },
      [{ code: 'criterion_without_check', id: 'AC2' }],
    ],
    [
      'a check for an unknown criterion',
      { ...PLAN, checks: [...PLAN.checks, { criterion: 'AC7', how: 'x' }] },
      [{ code: 'unknown_criterion', id: 'AC7' }],
    ],
  ])('reports %s', (_name, plan, findings) => {
    expect(checkPlan(plan, SPEC)).toEqual(findings)
  })

  it('lists the files the plan touches once each, sorted', () => {
    expect(planFiles(PLAN)).toEqual(['src/retry.test.ts', 'src/retry.ts'])
  })

  it('renders the plan with its steps and checks', () => {
    const text = renderPlan(PLAN)
    expect(text).toContain('1. **Backoff** (R1) — `src/retry.ts`, `src/retry.test.ts` — est. $0.40')
    expect(text).toContain('| AC2 | unit test of the fourth failure |')
  })
})

describe('checkReport', () => {
  const REPORT = {
    summary: 'One failed',
    criteria: [
      { id: 'AC1', status: 'pass' as const, evidence: 'test passes' },
      { id: 'AC2', status: 'fail' as const, evidence: 'no dead letter' },
    ],
  }

  it('accepts a verdict on every criterion', () => {
    expect(checkReport(REPORT, SPEC.criteria)).toEqual([])
  })

  it.each([
    [
      'a missing criterion',
      { ...REPORT, criteria: [REPORT.criteria[0]!] },
      [{ code: 'missing_criterion', id: 'AC2' }],
    ],
    [
      'an unknown criterion',
      {
        ...REPORT,
        criteria: [...REPORT.criteria, { id: 'AC9', status: 'pass' as const, evidence: 'x' }],
      },
      [{ code: 'unknown_criterion', id: 'AC9' }],
    ],
    [
      'a criterion twice',
      { ...REPORT, criteria: [...REPORT.criteria, REPORT.criteria[0]!] },
      [{ code: 'duplicate_criterion', id: 'AC1' }],
    ],
  ])('reports %s', (_name, report, findings) => {
    expect(checkReport(report, SPEC.criteria)).toEqual(findings)
  })

  it('renders a table with a mark per criterion', () => {
    expect(renderReport(REPORT)).toContain('| AC2 | ✘ fail | no dead letter |')
  })
})

describe('checkReport on owner checks', () => {
  const marked = [
    { id: 'AC1', requirements: ['R1'], text: 'a' },
    { id: 'AC2', requirements: ['R2'], text: 'b', owner: true },
  ]
  const verdicts = (a: 'pass' | 'fail' | 'owner', b: 'pass' | 'fail' | 'owner') => ({
    summary: 's',
    criteria: [
      { id: 'AC1', status: a, evidence: 'e' },
      { id: 'AC2', status: b, evidence: 'e' },
    ],
  })
  it.each([
    ['pass', 'owner', []],
    ['fail', 'owner', []],
    ['pass', 'fail', []],
    ['fail', 'fail', []],
    ['owner', 'owner', [{ code: 'owner_on_unmarked_criterion', id: 'AC1' }]],
    ['pass', 'pass', [{ code: 'pass_on_owner_check', id: 'AC2' }]],
  ] as const)('AC1 %s, AC2 %s', (a, b, findings) => {
    expect(checkReport(verdicts(a, b), marked)).toEqual(findings)
  })
})

describe('renderReport on owner verdicts', () => {
  const report = (...owners: string[]) => ({
    summary: 's',
    criteria: ['AC4', 'AC5', 'AC6'].map((id) => ({
      id,
      status: owners.includes(id) ? ('owner' as const) : ('pass' as const),
      evidence: 'e',
    })),
  })
  it.each([
    [[], undefined],
    [['AC5'], '1 criterion is yours to check: AC5.'],
    [['AC5', 'AC6'], '2 criteria are yours to check: AC5, AC6.'],
  ] as const)('owners %j', (owners, sentence) => {
    const text = renderReport(report(...owners))
    if (sentence === undefined) expect(text).not.toContain('yours to check')
    else {
      expect(text).toContain(`${sentence}\n\n| Criterion`)
      expect(text).toContain('| AC5 | 👁 owner | e |')
    }
    expect(text).toContain('| AC4 | ✔ pass | e |')
  })
})

describe('checkPlan on withdrawals', () => {
  const ANSWER = 'Drop AC2: the file is gone.'
  const BASE: PlanInput = {
    ...PLAN,
    confidence: 'medium',
    checks: [PLAN.checks[0]!],
    withdrawn: [{ criterion: 'AC2', answer: ANSWER }],
  }
  const withEntry = (answer: string): PlanInput => ({
    ...BASE,
    withdrawn: [{ criterion: 'AC2', answer }],
  })
  interface Row {
    name: string
    plan: PlanInput
    answers: string[]
    expected: { code: string; id: string }[]
  }
  const ROWS: Row[] = [
    { name: 'the base plan', plan: BASE, answers: [ANSWER], expected: [] },
    {
      name: 'an unknown id',
      plan: { ...BASE, withdrawn: [...BASE.withdrawn!, { criterion: 'AC9', answer: ANSWER }] },
      answers: [ANSWER],
      expected: [{ code: 'unknown_withdrawn_criterion', id: 'AC9' }],
    },
    {
      name: 'a duplicate id',
      plan: { ...BASE, withdrawn: [...BASE.withdrawn!, { criterion: 'AC2', answer: ANSWER }] },
      answers: [ANSWER],
      expected: [{ code: 'duplicate_withdrawn_criterion', id: 'AC2' }],
    },
    {
      name: 'confidence high',
      plan: { ...BASE, confidence: 'high' },
      answers: [ANSWER],
      expected: [{ code: 'withdrawal_without_gate', id: 'high' }],
    },
    {
      name: 'a check for the withdrawn criterion',
      plan: { ...BASE, checks: PLAN.checks },
      answers: [ANSWER],
      expected: [{ code: 'withdrawn_criterion_with_check', id: 'AC2' }],
    },
    {
      name: 'words the owner did not write',
      plan: withEntry('Remove AC2 entirely.'),
      answers: [ANSWER],
      expected: [{ code: 'withdrawn_answer_not_found', id: 'AC2' }],
    },
    {
      name: 'a blank answer',
      plan: withEntry('   '),
      answers: [ANSWER],
      expected: [{ code: 'withdrawn_answer_not_found', id: 'AC2' }],
    },
    { name: 'an excerpt', plan: withEntry('the file is gone'), answers: [ANSWER], expected: [] },
    {
      name: 'a quote with other whitespace',
      plan: withEntry('Drop AC2:\n  the file   is gone.'),
      answers: [ANSWER],
      expected: [],
    },
    {
      name: 'an owner answer with a line break',
      plan: BASE,
      answers: ['Drop AC2:\nthe file is gone.'],
      expected: [],
    },
  ]
  it.each(ROWS)('$name', ({ plan, answers, expected }) => {
    expect(checkPlan(plan, SPEC, answers)).toEqual(expected)
  })
})

describe('renderPlan on withdrawals', () => {
  it('lists each withdrawal after the checks, a line break written as a space', () => {
    const text = renderPlan({
      ...PLAN,
      checks: [PLAN.checks[0]!],
      withdrawn: [{ criterion: 'AC2', answer: 'Drop AC2:\nthe file is gone.' }],
    })
    expect(text.endsWith('\n\nWithdrawn by the owner:\n- AC2 — Drop AC2: the file is gone.')).toBe(
      true,
    )
  })
  it('renders a plan with no withdrawal as before', () => {
    expect(renderPlan({ ...PLAN, withdrawn: [] })).toBe(renderPlan(PLAN))
    expect(renderPlan(PLAN)).not.toContain('Withdrawn')
  })
})

describe('checkReport on withdrawals', () => {
  const criteria = [
    { id: 'AC1', requirements: ['R1'], text: 'a' },
    { id: 'AC2', requirements: ['R2'], text: 'b' },
    { id: 'AC3', requirements: ['R2'], text: 'c', owner: true },
  ]
  type Status = 'pass' | 'fail' | 'owner' | 'withdrawn'
  const report = (a: Status, b: Status, c: Status) => ({
    summary: 's',
    criteria: [
      { id: 'AC1', status: a, evidence: 'e' },
      { id: 'AC2', status: b, evidence: 'e' },
      { id: 'AC3', status: c, evidence: 'e' },
    ],
  })
  interface Row {
    name: string
    verdicts: [Status, Status, Status]
    ids: string[]
    expected: { code: string; id: string }[]
  }
  const ROWS: Row[] = [
    { name: 'the base', verdicts: ['pass', 'withdrawn', 'owner'], ids: ['AC2'], expected: [] },
    {
      name: 'AC1 withdrawn',
      verdicts: ['withdrawn', 'withdrawn', 'owner'],
      ids: ['AC2'],
      expected: [{ code: 'withdrawn_not_in_plan', id: 'AC1' }],
    },
    {
      name: 'AC2 pass',
      verdicts: ['pass', 'pass', 'owner'],
      ids: ['AC2'],
      expected: [{ code: 'withdrawn_criterion_judged', id: 'AC2' }],
    },
    {
      name: 'AC2 fail',
      verdicts: ['pass', 'fail', 'owner'],
      ids: ['AC2'],
      expected: [{ code: 'withdrawn_criterion_judged', id: 'AC2' }],
    },
    {
      name: 'no accepted plan',
      verdicts: ['pass', 'withdrawn', 'owner'],
      ids: [],
      expected: [{ code: 'withdrawn_not_in_plan', id: 'AC2' }],
    },
    {
      name: 'an owner-marked criterion withdrawn',
      verdicts: ['pass', 'withdrawn', 'withdrawn'],
      ids: ['AC2', 'AC3'],
      expected: [],
    },
    {
      name: 'AC1 owner',
      verdicts: ['owner', 'withdrawn', 'owner'],
      ids: ['AC2'],
      expected: [{ code: 'owner_on_unmarked_criterion', id: 'AC1' }],
    },
    {
      name: 'AC3 pass',
      verdicts: ['pass', 'withdrawn', 'pass'],
      ids: ['AC2'],
      expected: [{ code: 'pass_on_owner_check', id: 'AC3' }],
    },
  ]
  it.each(ROWS)('$name', ({ verdicts, ids, expected }) => {
    expect(checkReport(report(...verdicts), criteria, new Set(ids))).toEqual(expected)
  })
})

describe('renderReport on withdrawals', () => {
  type Status = 'pass' | 'owner' | 'withdrawn'
  const report = (statuses: Record<string, Status>, answer: string) => ({
    summary: 's',
    criteria: Object.entries(statuses).map(([id, status]) => ({ id, status, evidence: 'e' })),
    withdrawn: Object.entries(statuses)
      .filter(([, status]) => status === 'withdrawn')
      .map(([criterion]) => ({ criterion, answer })),
  })
  const HEAD = 'Withdrawn by the owner at the plan gate:'
  interface Row {
    name: string
    input: ReturnType<typeof report>
    contains: string[]
    absent: string[]
  }
  const ROWS: Row[] = [
    {
      name: 'one withdrawal',
      input: report({ AC5: 'pass', AC6: 'withdrawn' }, 'Drop AC6:\nthe file is gone.'),
      contains: [
        `${HEAD}\n- AC6 — Drop AC6: the file is gone.\n\n| Criterion`,
        '| AC6 | ⊘ withdrawn | e |',
      ],
      absent: [],
    },
    {
      name: 'two withdrawals in order',
      input: report({ AC5: 'withdrawn', AC6: 'withdrawn' }, 'x'),
      contains: [`${HEAD}\n- AC5 — x\n- AC6 — x\n`],
      absent: [],
    },
    {
      name: 'the owner sentence first',
      input: report({ AC4: 'owner', AC6: 'withdrawn' }, 'x'),
      contains: ['yours to check: AC4.\n\nWithdrawn by the owner at the plan gate:'],
      absent: [],
    },
    {
      name: 'no withdrawal',
      input: report({ AC4: 'pass', AC6: 'owner' }, 'x'),
      contains: ['| AC4 | ✔ pass | e |'],
      absent: ['Withdrawn by the owner'],
    },
  ]
  it.each(ROWS)('$name', ({ input, contains, absent }) => {
    const text = renderReport(input)
    for (const part of contains) expect(text).toContain(part)
    for (const part of absent) expect(text).not.toContain(part)
  })
})

interface CheckRow {
  name: string
  criterion: string
  how: string
  line: string
}
const CHECK_ROWS: CheckRow[] = [
  { name: 'a pipe in how', criterion: 'AC1', how: 'a | b', line: '| AC1 | a \\| b |' },
  { name: 'a newline in how', criterion: 'AC1', how: 'one\ntwo', line: '| AC1 | one two |' },
  { name: 'a CRLF in how', criterion: 'AC1', how: 'one\r\ntwo', line: '| AC1 | one two |' },
  { name: 'a pipe in criterion', criterion: 'A|C', how: 'x', line: '| A\\|C | x |' },
]

describe('renderPlan check cells', () => {
  it.each(CHECK_ROWS)('writes $name as a single table row', ({ criterion, how, line }) => {
    const rendered = renderPlan({ ...PLAN, checks: [{ criterion, how }] })
    expect(rendered.split('\n')).toContain(line)
  })
})
