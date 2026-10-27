import { describe, expect, it } from 'vitest'
import {
  isAccepted,
  planToKeep,
  previousPlans,
  type PlanApprovalRecord,
  type PlanRecord,
} from '../../src/modules/tasks/plan-history.js'

let clock = 0
const plan = (over: Partial<PlanRecord> & { id: string }): PlanRecord => ({
  runId: 'r1',
  runNumber: 1,
  specVersion: 1,
  createdAt: new Date(2026, 0, 1, 0, 0, (clock += 1)),
  bodyMd: `body ${over.id}`,
  confidence: 'medium',
  copiedFromRun: null,
  ...over,
})
const approve = (runId: string, contextMd: string, optionId: string | null = 'approve') =>
  ({ runId, contextMd, optionId }) satisfies PlanApprovalRecord

interface KeepCase {
  name: string
  plans: PlanRecord[]
  approvals: PlanApprovalRecord[]
  version: number
  keep: string | null
}
const KEEP: KeepCase[] = [
  {
    name: 'AC1: an approved medium plan, no build ever started',
    plans: [plan({ id: 'a' })],
    approvals: [approve('r1', 'body a')],
    version: 1,
    keep: 'a',
  },
  {
    name: 'AC2: run 1 high plan beats run 2 unapproved medium plan',
    plans: [plan({ id: 'a', confidence: 'high' }), plan({ id: 'b', runId: 'r2', runNumber: 2 })],
    approvals: [],
    version: 1,
    keep: 'a',
  },
  {
    name: 'AC3: nothing approved and nothing high',
    plans: [plan({ id: 'a' }), plan({ id: 'b', confidence: 'low', runId: 'r2', runNumber: 2 })],
    approvals: [],
    version: 1,
    keep: null,
  },
  {
    name: 'a phase with two plans: only the one the approval showed is accepted',
    plans: [plan({ id: 'a' }), plan({ id: 'b' })],
    approvals: [approve('r1', 'body a')],
    version: 1,
    keep: 'a',
  },
  {
    name: 'an approval that was answered with words approves nothing',
    plans: [plan({ id: 'a' })],
    approvals: [approve('r1', 'body a', null)],
    version: 1,
    keep: null,
  },
  {
    name: 'an approval of another run approves nothing',
    plans: [plan({ id: 'a' })],
    approvals: [approve('r2', 'body a')],
    version: 1,
    keep: null,
  },
  {
    name: 'a plan of another spec version is not kept',
    plans: [plan({ id: 'a', confidence: 'high', specVersion: 1 })],
    approvals: [],
    version: 2,
    keep: null,
  },
  {
    name: 'a copied plan is accepted',
    plans: [plan({ id: 'a', copiedFromRun: 1 })],
    approvals: [],
    version: 1,
    keep: 'a',
  },
]

describe('planToKeep', () => {
  it.each(KEEP)('$name', ({ plans, approvals, version, keep }) => {
    expect(planToKeep(plans, approvals, version)?.id ?? null).toBe(keep)
  })
})

describe('isAccepted', () => {
  it('accepts a high plan', () => {
    expect(isAccepted(plan({ id: 'a', confidence: 'high' }), [])).toBe(true)
  })
})

interface PrevCase {
  name: string
  plans: PlanRecord[]
  approvals: PlanApprovalRecord[]
  exclude: string | undefined
  expected: [string, boolean][]
}
const PREV: PrevCase[] = [
  {
    name: 'AC9: the newest plan, approved',
    plans: [plan({ id: 'a' })],
    approvals: [approve('r1', 'body a')],
    exclude: undefined,
    expected: [['a', true]],
  },
  {
    name: 'AC10: an unapproved newest plan and an older accepted one',
    plans: [plan({ id: 'a', confidence: 'high' }), plan({ id: 'b', runId: 'r2', runNumber: 2 })],
    approvals: [],
    exclude: undefined,
    expected: [
      ['b', false],
      ['a', true],
    ],
  },
  {
    name: 'AC11: no plans',
    plans: [],
    approvals: [],
    exclude: undefined,
    expected: [],
  },
  {
    name: 'the current run own plans are left out',
    plans: [plan({ id: 'a', confidence: 'high' }), plan({ id: 'b', runId: 'r2', runNumber: 2 })],
    approvals: [],
    exclude: 'r2',
    expected: [['a', true]],
  },
  {
    name: 'only plans without an accepted one: just the newest',
    plans: [plan({ id: 'a' }), plan({ id: 'b', runId: 'r2', runNumber: 2 })],
    approvals: [],
    exclude: undefined,
    expected: [['b', false]],
  },
]

describe('previousPlans', () => {
  it.each(PREV)('$name', ({ plans, approvals, exclude, expected }) => {
    const found = previousPlans(plans, approvals, 1, exclude)
    expect(found.map((p) => [p.plan.id, p.accepted])).toEqual(expected)
  })
})
