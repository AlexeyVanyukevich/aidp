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
