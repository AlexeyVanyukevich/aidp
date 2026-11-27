import { describe, expect, it } from 'vitest'
import {
  checkDecisionResult,
  decisionResultOf,
  type DecisionCheckFacts,
  type DecisionResultInput,
} from '../../src/modules/approvals/help-rules.js'

type Mode = 'review' | 'review_plan' | 'restate' | 'recommend' | 'check' | 'code_review'
interface Row {
  name: string
  mode: Mode
  input: DecisionResultInput
  facts?: Partial<DecisionCheckFacts>
  /** `field:code` of the findings, empty when the result is saved. */
  expected: string[]
}

const FACTS: DecisionCheckFacts = {
  recommendable: ['cancel', 'rerun_again', 'mark_done'],
  checkedAgainst: 'approved_spec',
  planToKeep: false,
  ownProject: 'AIDP',
  linkedProjects: ['CHR', 'ZLR'],
}
const long = 'x'.repeat(4_001)
const item = { kind: 'missing', text: 'No retry limit', destination: 'blocker', evidence: 'R3' }
const next = {
  kind: 'risk',
  where: 'Context',
  text: 'Vague',
  destination: 'next_gate',
  evidence: 'Context',
}
const outside = {
  kind: 'risk',
  text: '**Where:** a.ts\n**Found:** today\n**Problem:** p\n**Impact:** i',
  title: 'A bug elsewhere',
  destination: 'outside',
  evidence: 'a.ts:1',
}

const rows: Row[] = [
  { name: 'a blocker', mode: 'review', input: { findings: [item], unsure: 'u' }, expected: [] },
  { name: 'no findings', mode: 'review', input: { unsure: 'u' }, expected: [] },
  {
    name: 'a verdict is not saved',
    mode: 'review',
    input: { verdict: 'changes', findings: [item], unsure: 'u' },
    expected: ['verdict:not_allowed'],
  },
  {
    name: 'a finding without a destination',
    mode: 'review',
    input: { findings: [{ ...item, destination: undefined }], unsure: 'u' },
    expected: ['findings:required'],
  },
  {
    name: 'a destination of later',
    mode: 'review',
    input: { findings: [{ ...item, destination: 'later' }], unsure: 'u' },
    expected: ['findings:unknown_destination'],
  },
  {
    name: 'a finding without evidence',
    mode: 'review',
    input: { findings: [{ ...item, evidence: undefined }], unsure: 'u' },
    expected: ['findings:required'],
  },
  {
    name: 'evidence of 501 characters',
    mode: 'review',
    input: { findings: [{ ...item, evidence: 'e'.repeat(501) }], unsure: 'u' },
    expected: ['findings:too_long'],
  },
  {
    name: 'an outside finding',
    mode: 'review',
    input: { findings: [outside], unsure: 'u' },
    expected: [],
  },
  {
    name: 'an outside finding without Impact',
    mode: 'review',
    input: {
      findings: [{ ...outside, text: '**Where:** a\n**Found:** b\n**Problem:** c' }],
      unsure: 'u',
    },
    expected: ['findings:required'],
  },
  {
    name: 'an outside finding without a title',
    mode: 'review',
    input: { findings: [{ ...outside, title: undefined }], unsure: 'u' },
    expected: ['findings:required'],
  },
  {
    name: 'an outside title of 201 characters',
    mode: 'review',
    input: { findings: [{ ...outside, title: 't'.repeat(201) }], unsure: 'u' },
    expected: ['findings:too_long'],
  },
  {
    name: 'a blocker with a title',
    mode: 'review',
    input: { findings: [{ ...item, title: 'T' }], unsure: 'u' },
    expected: ['findings:not_allowed'],
  },
  {
    name: 'a next-gate finding with an edit',
    mode: 'review',
    input: { findings: [{ ...next, edit: 'Say which.' }], unsure: 'u' },
    expected: ['findings:not_allowed'],
  },
  {
    name: 'a next-gate finding with where and no edit',
    mode: 'review',
    input: { findings: [next], unsure: 'u' },
    expected: [],
  },
  {
    name: 'a next-gate finding without where',
    mode: 'review',
    input: { findings: [{ ...next, where: undefined }], unsure: 'u' },
    expected: ['findings:required'],
  },
  {
    name: 'an edit of 4001 characters',
    mode: 'review',
    input: { findings: [{ ...next, edit: long }], unsure: 'u' },
    expected: ['findings:not_allowed'],
  },
  {
    name: 'a blocker with an edit',
    mode: 'review',
    input: { findings: [{ ...item, edit: 'x' }], unsure: 'u' },
    expected: ['findings:not_allowed'],
  },
  {
    name: 'an unknown finding kind',
    mode: 'review',
    input: { findings: [{ ...item, kind: 'nit' }], unsure: 'u' },
    expected: ['findings:unknown_kind'],
  },
  {
    name: 'a long where',
    mode: 'review',
    input: { findings: [{ ...item, where: 'w'.repeat(101) }], unsure: 'u' },
    expected: ['findings:too_long'],
  },
  {
    name: 'thirty-one findings',
    mode: 'review',
    input: { findings: Array.from({ length: 31 }, () => item), unsure: 'u' },
    expected: ['findings:too_many'],
  },
  { name: 'a review without unsure', mode: 'review', input: {}, expected: ['unsure:required'] },
  {
    name: 'a question field in a review',
    mode: 'review',
    input: { unsure: 'u', asked: 'a' },
    expected: ['asked:not_allowed'],
  },
  {
    name: 'a plan review of a criterion',
    mode: 'review_plan',
    input: {
      findings: [{ ...item, kind: 'uncovered', where: 'R3', evidence: 'R3' }],
      unsure: 'u',
    },
    expected: [],
  },
  ...['missing_file', 'risk', 'simpler'].map((kind) => ({
    name: `a plan review finding of kind ${kind}`,
    mode: 'review_plan' as const,
    input: { findings: [{ ...item, kind }], unsure: 'u' },
    expected: [],
  })),
  {
    name: 'a plan review finding of kind bug',
    mode: 'review_plan',
    input: { findings: [{ ...item, kind: 'bug' }], unsure: 'u' },
    expected: ['findings:unknown_kind'],
  },
  {
    name: 'a plan review next-gate finding with an edit',
    mode: 'review_plan',
    input: { findings: [{ ...next, edit: 'x' }], unsure: 'u' },
    expected: ['findings:not_allowed'],
  },
  {
    name: 'a plan review next-gate finding',
    mode: 'review_plan',
    input: {
      findings: [{ ...item, destination: 'next_gate', kind: 'risk' }],
      unsure: 'u',
    },
    expected: [],
  },
  {
    name: 'a plan review with choices',
    mode: 'review_plan',
    input: {
      findings: [{ ...item, kind: 'risk', choices: ['a', 'b'], recommended: 0 }],
      unsure: 'u',
    },
    expected: [],
  },
  ...(['option_id', 'text', 'asked', 'matters', 'leads_to'] as const).map((field) => ({
    name: `${field} in a plan review`,
    mode: 'review_plan' as const,
    input: { findings: [], unsure: 'u', [field]: 'x' },
    expected: [`${field}:not_allowed`],
  })),
  {
    name: 'answers in a plan review',
    mode: 'review_plan',
    input: { unsure: 'u', answers: [{ question_id: 'q' }] } as DecisionResultInput,
    expected: ['answers:not_allowed'],
  },
  {
    name: 'a restatement',
    mode: 'restate',
    input: { changes: 'c', requirements: 'r', left_out: 'l' },
    expected: [],
  },
  {
    name: 'a restatement with a verdict',
    mode: 'restate',
    input: { changes: 'c', requirements: 'r', left_out: 'l', verdict: 'changes' },
    expected: ['verdict:not_allowed'],
  },
  {
    name: 'a restatement with blank parts',
    mode: 'restate',
    input: { changes: ' ', requirements: 'r' },
    expected: ['changes:required', 'left_out:required'],
  },
  {
    name: 'a restatement too long',
    mode: 'restate',
    input: { changes: long, requirements: 'r', left_out: 'l' },
    expected: ['changes:too_long'],
  },
  {
    name: 'a recommendation',
    mode: 'recommend',
    input: { why_stopped: 'w', action: 'cancel', reasoning: 'r', unsure: 'u' },
    expected: [],
  },
  {
    name: 'rerun_keep with no plan to keep',
    mode: 'recommend',
    input: { why_stopped: 'w', action: 'rerun_keep', reasoning: 'r', unsure: 'u' },
    expected: ['action:not_offered'],
  },
  {
    name: 'redraft, offered on a Failed card',
    mode: 'recommend',
    input: { why_stopped: 'w', action: 'redraft', reasoning: 'r', unsure: 'u' },
    facts: { recommendable: ['rerun_again', 'mark_done', 'redraft'] },
    expected: [],
  },
  {
    name: 'redraft, not offered on a Blocked card',
    mode: 'recommend',
    input: { why_stopped: 'w', action: 'redraft', reasoning: 'r', unsure: 'u' },
    expected: ['action:not_offered'],
  },
  {
    name: 'resume with no checkpoint',
    mode: 'recommend',
    input: { why_stopped: 'w', action: 'resume', reasoning: 'r', unsure: 'u' },
    expected: ['action:not_offered'],
  },
  {
    name: 'an unknown action',
    mode: 'recommend',
    input: { why_stopped: 'w', action: 'retry', reasoning: 'r', unsure: 'u' },
    expected: ['action:unknown_action'],
  },
  {
    name: 'a recommendation without reasoning',
    mode: 'recommend',
    input: { why_stopped: 'w', action: 'cancel', unsure: 'u' },
    expected: ['reasoning:required'],
  },
  {
    name: 'a check',
    mode: 'check',
    input: {
      checked_against: 'approved_spec',
      produced: 'p',
      unfinished: [{ text: 't' }],
      unsure: 'u',
    },
    expected: [],
  },
  {
    name: 'a check with nothing unfinished',
    mode: 'check',
    input: { checked_against: 'approved_spec', produced: 'p', unfinished: [], unsure: 'u' },
    expected: [],
  },
  {
    name: 'approved_spec in Backlog',
    mode: 'check',
    input: { checked_against: 'approved_spec', produced: 'p', unsure: 'u' },
    facts: { checkedAgainst: 'description' },
    expected: ['checked_against:wrong_source'],
  },
  {
    name: 'a check without produced',
    mode: 'check',
    input: { checked_against: 'approved_spec', unsure: 'u' },
    expected: ['produced:required'],
  },
  {
    name: 'a recommendation field in a check',
    mode: 'check',
    input: { checked_against: 'approved_spec', produced: 'p', unsure: 'u', action: 'cancel' },
    expected: ['action:not_allowed'],
  },
]

const bug = {
  kind: 'bug',
  file: 'server/src/a.ts',
  line: 12,
  text: 'Off by one',
  matters: 'Loses a row',
  destination: 'blocker',
  evidence: 'server/src/a.ts:12',
}
const outsideCode = { ...bug, destination: 'outside', title: 'Elsewhere', text: outside.text }
const step = (next_step: string, extra: Partial<DecisionResultInput> = {}) => ({
  unsure: 'u',
  reasoning: 'r',
  next_step,
  ...extra,
})
const codeRows: Row[] = [
  {
    name: 'a code review finding with an edit',
    mode: 'code_review',
    input: { findings: [{ ...bug, edit: 'x' }], ...step('fix_by_hand') },
    expected: ['findings:not_allowed'],
  },
  {
    name: 'a code review with a blocker and fix_by_hand',
    mode: 'code_review',
    input: { findings: [bug], ...step('fix_by_hand') },
    expected: [],
  },
  {
    name: 'a finding without a line',
    mode: 'code_review',
    input: { findings: [{ ...bug, line: undefined }], ...step('fix_by_hand') },
    expected: [],
  },
  {
    name: 'merge with no findings',
    mode: 'code_review',
    input: step('merge'),
    expected: [],
  },
  {
    name: 'merge with one finding',
    mode: 'code_review',
    input: { findings: [outsideCode], ...step('merge') },
    expected: ['next_step:not_offered'],
  },
  {
    name: 'merge_and_file with one outside finding',
    mode: 'code_review',
    input: { findings: [outsideCode], ...step('merge_and_file') },
    expected: [],
  },
  {
    name: 'merge_and_file with only a blocker',
    mode: 'code_review',
    input: { findings: [bug], ...step('merge_and_file') },
    expected: ['next_step:not_offered'],
  },
  {
    name: 'fix_by_hand with only an outside finding',
    mode: 'code_review',
    input: { findings: [outsideCode], ...step('fix_by_hand') },
    expected: ['next_step:not_offered'],
  },
  {
    name: 'rerun_keep with only an outside finding',
    mode: 'code_review',
    input: { findings: [outsideCode], ...step('rerun_keep') },
    facts: { planToKeep: true },
    expected: ['next_step:not_offered'],
  },
  {
    name: 'rerun_again with no findings',
    mode: 'code_review',
    input: step('rerun_again'),
    expected: ['next_step:not_offered'],
  },
  {
    name: 'rerun_keep with a blocker and no plan to keep',
    mode: 'code_review',
    input: { findings: [bug], ...step('rerun_keep') },
    expected: ['next_step:not_offered'],
  },
  {
    name: 'rerun_keep with a blocker and a plan to keep',
    mode: 'code_review',
    input: { findings: [bug], ...step('rerun_keep') },
    facts: { planToKeep: true },
    expected: [],
  },
  {
    name: 'a next step of resume',
    mode: 'code_review',
    input: { findings: [bug], ...step('resume') },
    expected: ['next_step:unknown_action'],
  },
  {
    name: 'a code review without a next step',
    mode: 'code_review',
    input: { unsure: 'u', reasoning: 'r' },
    expected: ['next_step:required'],
  },
  {
    name: 'a code review without reasoning',
    mode: 'code_review',
    input: { unsure: 'u', next_step: 'merge' },
    expected: ['reasoning:required'],
  },
  {
    name: 'a next-gate finding in a code review',
    mode: 'code_review',
    input: { findings: [bug, { ...bug, destination: 'next_gate' }], ...step('fix_by_hand') },
    expected: ['findings:not_offered'],
  },
  {
    name: 'a verdict in a code review',
    mode: 'code_review',
    input: { verdict: 'changes', findings: [bug], ...step('fix_by_hand') },
    expected: ['verdict:not_allowed'],
  },
  {
    name: 'a kind of style',
    mode: 'code_review',
    input: { findings: [{ ...bug, kind: 'style' }], ...step('fix_by_hand') },
    expected: ['findings:unknown_kind'],
  },
  {
    name: 'a blank file',
    mode: 'code_review',
    input: { findings: [{ ...bug, file: ' ' }], ...step('fix_by_hand') },
    expected: ['findings:required'],
  },
  {
    name: 'a file of 301 characters',
    mode: 'code_review',
    input: { findings: [{ ...bug, file: 'f'.repeat(301) }], ...step('fix_by_hand') },
    expected: ['findings:too_long'],
  },
  {
    name: 'a line of 0',
    mode: 'code_review',
    input: { findings: [{ ...bug, line: 0 }], ...step('fix_by_hand') },
    expected: ['findings:invalid_line'],
  },
  {
    name: 'a fractional line',
    mode: 'code_review',
    input: { findings: [{ ...bug, line: 1.5 }], ...step('fix_by_hand') },
    expected: ['findings:invalid_line'],
  },
  {
    name: 'a missing matters',
    mode: 'code_review',
    input: { findings: [{ ...bug, matters: undefined }], ...step('fix_by_hand') },
    expected: ['findings:required'],
  },
  {
    name: 'a text that is too long',
    mode: 'code_review',
    input: { findings: [{ ...bug, text: long }], ...step('fix_by_hand') },
    expected: ['findings:too_long'],
  },
  {
    name: 'thirty-one findings',
    mode: 'code_review',
    input: { findings: Array.from({ length: 31 }, () => bug), ...step('fix_by_hand') },
    expected: ['findings:too_many'],
  },
  {
    name: 'a code review without unsure',
    mode: 'code_review',
    input: { reasoning: 'r', next_step: 'merge' },
    expected: ['unsure:required'],
  },
  {
    name: 'a field of another mode',
    mode: 'code_review',
    input: { ...step('merge'), why_stopped: 'w' },
    expected: ['why_stopped:not_allowed'],
  },
]
rows.push(...codeRows)

/** A Review spec row that does not name its own step gets the one its findings call for. */
const withStep = (mode: Mode, input: DecisionResultInput): DecisionResultInput => {
  if (mode !== 'review' || 'next_step' in input) return input
  const list = input.findings ?? []
  const has = (destination: string) => list.some((f) => f.destination === destination)
  const next_step = has('blocker') ? 'redraft' : has('next_gate') ? 'approve_with_note' : 'approve'
  return { next_step, reasoning: 'r', ...input }
}

const specStep = (next_step: string | undefined, extra: Partial<DecisionResultInput> = {}) => ({
  unsure: 'u',
  reasoning: 'r',
  next_step,
  ...extra,
})
const reviewStepRows: Row[] = [
  { name: 'approve with no findings', mode: 'review', input: specStep('approve'), expected: [] },
  {
    name: 'approve with an outside finding',
    mode: 'review',
    input: specStep('approve', { findings: [outside] }),
    expected: [],
  },
  {
    name: 'approve with a blocker',
    mode: 'review',
    input: specStep('approve', { findings: [item] }),
    expected: ['next_step:not_offered'],
  },
  {
    name: 'approve with a next-gate finding',
    mode: 'review',
    input: specStep('approve', { findings: [next] }),
    expected: ['next_step:not_offered'],
  },
  {
    name: 'approve_with_note with a next-gate finding',
    mode: 'review',
    input: specStep('approve_with_note', { findings: [next] }),
    expected: [],
  },
  {
    name: 'approve_with_note with a blocker and a next-gate finding',
    mode: 'review',
    input: specStep('approve_with_note', { findings: [item, next] }),
    expected: ['next_step:not_offered'],
  },
  {
    name: 'approve_with_note with no next-gate finding',
    mode: 'review',
    input: specStep('approve_with_note', { findings: [outside] }),
    expected: ['next_step:not_offered'],
  },
  {
    name: 'redraft with a blocker',
    mode: 'review',
    input: specStep('redraft', { findings: [item] }),
    expected: [],
  },
  {
    name: 'redraft with no blocker',
    mode: 'review',
    input: specStep('redraft', { findings: [next] }),
    expected: ['next_step:not_offered'],
  },
  {
    name: 'an unknown spec step',
    mode: 'review',
    input: specStep('merge'),
    expected: ['next_step:unknown_action'],
  },
  {
    name: 'a missing spec step',
    mode: 'review',
    input: specStep(undefined),
    expected: ['next_step:required'],
  },
  {
    name: 'a blank spec reasoning',
    mode: 'review',
    input: specStep('approve', { reasoning: '  ' }),
    expected: ['reasoning:required'],
  },
  {
    name: 'an outside finding naming the own project',
    mode: 'review',
    input: specStep('approve', { findings: [{ ...outside, project: 'AIDP' }] }),
    expected: [],
  },
  {
    name: 'an outside finding naming a linked project',
    mode: 'review',
    input: specStep('approve', { findings: [{ ...outside, project: 'CHR' }] }),
    expected: [],
  },
  {
    name: 'an outside finding naming an unlinked project',
    mode: 'review',
    input: specStep('approve', { findings: [{ ...outside, project: 'XYZ' }] }),
    expected: ['findings:not_offered'],
  },
  {
    name: 'a blocker naming a project',
    mode: 'review',
    input: specStep('redraft', { findings: [{ ...item, project: 'CHR' }] }),
    expected: ['findings:not_allowed'],
  },
  {
    name: 'a plan review outside finding naming a linked project',
    mode: 'review_plan',
    input: { findings: [{ ...outside, project: 'CHR' }], unsure: 'u' },
    expected: [],
  },
  {
    name: 'a plan review outside finding naming an unlinked project',
    mode: 'review_plan',
    input: { findings: [{ ...outside, project: 'XYZ' }], unsure: 'u' },
    expected: ['findings:not_offered'],
  },
  {
    name: 'a code review outside finding naming a linked project',
    mode: 'code_review',
    input: { findings: [{ ...outsideCode, project: 'CHR' }], ...step('merge_and_file') },
    expected: [],
  },
  {
    name: 'a code review outside finding naming an unlinked project',
    mode: 'code_review',
    input: { findings: [{ ...outsideCode, project: 'XYZ' }], ...step('merge_and_file') },
    expected: ['findings:not_offered'],
  },
  {
    name: 'a code review blocker naming a project',
    mode: 'code_review',
    input: { findings: [{ ...bug, project: 'CHR' }], ...step('fix_by_hand') },
    expected: ['findings:not_allowed'],
  },
]
rows.push(...reviewStepRows)

describe('checkDecisionResult', () => {
  it.each(rows)('$name', ({ mode, input, facts, expected }) => {
    const found = checkDecisionResult(mode, withStep(mode, input), { ...FACTS, ...facts }).map(
      (finding) => `${finding.field}:${finding.code}`,
    )
    expect(found).toEqual(expected)
  })
})

describe('decisionResultOf for the shared review shape', () => {
  const stored = (mode: 'review' | 'review_plan' | 'code_review', input: DecisionResultInput) =>
    decisionResultOf(mode, input) as { verdict: string; blockers: number }

  it.each([
    {
      name: 'two blockers and one next-gate',
      findings: [item, item, next],
      verdict: 'changes',
      blockers: 2,
    },
    {
      name: 'next-gate and outside only',
      findings: [next, outside],
      verdict: 'ready',
      blockers: 0,
    },
    { name: 'no findings', findings: [], verdict: 'ready', blockers: 0 },
  ])('derives $verdict from $name', ({ findings, verdict, blockers }) => {
    for (const mode of ['review', 'review_plan'] as const) {
      const result = stored(mode, { findings, unsure: 'u' })
      expect({ verdict: result.verdict, blockers: result.blockers }).toEqual({ verdict, blockers })
    }
  })
})

describe('decisionResultOf for a Review spec step and an outside project', () => {
  it('stores the step and reasoning trimmed, and the project key', () => {
    const result = decisionResultOf('review', {
      findings: [{ ...outside, project: 'CHR' }],
      unsure: 'u',
      next_step: 'approve',
      reasoning: '  Nothing blocks.  ',
    }) as unknown as { next_step: string; reasoning: string; findings: { project?: string }[] }
    expect(result.next_step).toBe('approve')
    expect(result.reasoning).toBe('Nothing blocks.')
    expect(result.findings[0]?.project).toBe('CHR')
  })
  it('stores no project when none is given', () => {
    const result = decisionResultOf('review', {
      findings: [outside],
      unsure: 'u',
      next_step: 'approve',
      reasoning: 'r',
    }) as unknown as { findings: object[] }
    expect('project' in (result.findings[0] ?? {})).toBe(false)
  })
})
