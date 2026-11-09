import { describe, expect, it } from 'vitest'
import {
  checkDecisionResult,
  type DecisionCheckFacts,
  type DecisionResultInput,
} from '../../src/modules/approvals/help-rules.js'

type Mode = 'review' | 'restate' | 'recommend' | 'check'
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
}
const long = 'x'.repeat(4_001)
const item = { kind: 'missing', text: 'No retry limit' }

const rows: Row[] = [
  {
    name: 'a review with changes',
    mode: 'review',
    input: { verdict: 'changes', findings: [item], unsure: 'u' },
    expected: [],
  },
  {
    name: 'nothing to change',
    mode: 'review',
    input: { verdict: 'nothing_to_change', unsure: 'u' },
    expected: [],
  },
  {
    name: 'nothing to change with findings',
    mode: 'review',
    input: { verdict: 'nothing_to_change', findings: [item], unsure: 'u' },
    expected: ['findings:not_allowed'],
  },
  {
    name: 'changes without findings',
    mode: 'review',
    input: { verdict: 'changes', findings: [], unsure: 'u' },
    expected: ['findings:required'],
  },
  {
    name: 'a review without a verdict',
    mode: 'review',
    input: { unsure: 'u' },
    expected: ['verdict:required'],
  },
  {
    name: 'an unknown finding kind',
    mode: 'review',
    input: { verdict: 'changes', findings: [{ kind: 'nit', text: 't' }], unsure: 'u' },
    expected: ['findings:unknown_kind'],
  },
  {
    name: 'a long where',
    mode: 'review',
    input: { verdict: 'changes', findings: [{ ...item, where: 'w'.repeat(101) }], unsure: 'u' },
    expected: ['findings:too_long'],
  },
  {
    name: 'thirty-one findings',
    mode: 'review',
    input: { verdict: 'changes', findings: Array.from({ length: 31 }, () => item), unsure: 'u' },
    expected: ['findings:too_many'],
  },
  {
    name: 'a review without unsure',
    mode: 'review',
    input: { verdict: 'nothing_to_change' },
    expected: ['unsure:required'],
  },
  {
    name: 'a question field in a review',
    mode: 'review',
    input: { verdict: 'nothing_to_change', unsure: 'u', asked: 'a' },
    expected: ['asked:not_allowed'],
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

describe('checkDecisionResult', () => {
  it.each(rows)('$name', ({ mode, input, facts, expected }) => {
    const found = checkDecisionResult(mode, input, { ...FACTS, ...facts }).map(
      (finding) => `${finding.field}:${finding.code}`,
    )
    expect(found).toEqual(expected)
  })
})
