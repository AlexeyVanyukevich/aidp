import { describe, expect, it } from 'vitest'
import {
  isAccepted,
  planAnswers,
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
let approvalSeq = 0
const approve = (runId: string, contextMd: string, optionId: string | null = 'approve') =>
  ({
    id: `a${(approvalSeq += 1)}`,
    runId,
    runNumber: 1,
    specVersion: 1,
    contextMd,
    optionId,
    answerText: null,
    answeredAt: new Date(2026, 0, 1),
  }) satisfies PlanApprovalRecord

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

const at = (n: number) => new Date(2026, 1, 1, 0, 0, n)
const answer = (
  id: string,
  runNumber: number,
  over: Partial<PlanApprovalRecord> = {},
): PlanApprovalRecord => ({
  id,
  runId: `run${runNumber}`,
  runNumber,
  specVersion: 1,
  contextMd: 'plan',
  optionId: null,
  answerText: 'words',
  answeredAt: at(Number(id.slice(1))),
  ...over,
})

interface AnswerCase {
  name: string
  approvals: PlanApprovalRecord[]
  version: number
  exclude: string | undefined
  expected: { run: number; approved: boolean; text: string }[]
}
const ANSWERS: AnswerCase[] = [
  {
    name: 'AC1: spec version, approve flag, blank answers and the current run',
    approvals: [
      answer('i1', 2, { answerText: 'two' }),
      answer('i2', 3, { optionId: 'approve', answerText: 'three' }),
      answer('i3', 3, { optionId: 'approve', answerText: null }),
      answer('i4', 4, { answerText: 'four' }),
      answer('i5', 5, { specVersion: 2, answerText: 'five' }),
    ],
    version: 1,
    exclude: 'run4',
    expected: [
      { run: 2, approved: false, text: 'two' },
      { run: 3, approved: true, text: 'three' },
    ],
  },
  {
    name: 'AC2: oldest answered first, whatever the insertion order',
    approvals: [
      answer('i1', 2, { answerText: 'late', answeredAt: at(20) }),
      answer('i2', 3, { answerText: 'early', answeredAt: at(10) }),
    ],
    version: 1,
    exclude: undefined,
    expected: [
      { run: 3, approved: false, text: 'early' },
      { run: 2, approved: false, text: 'late' },
    ],
  },
  {
    name: 'AC3: the same answered time is ordered by approval id',
    approvals: [
      answer('i2', 3, { answerText: 'greater', answeredAt: at(5) }),
      answer('i1', 2, { answerText: 'lesser', answeredAt: at(5) }),
    ],
    version: 1,
    exclude: undefined,
    expected: [
      { run: 2, approved: false, text: 'lesser' },
      { run: 3, approved: false, text: 'greater' },
    ],
  },
  {
    name: 'AC4: whitespace-only text is dropped',
    approvals: [answer('i1', 2, { answerText: ' \n\t ' })],
    version: 1,
    exclude: undefined,
    expected: [],
  },
  {
    name: 'AC4: text is trimmed',
    approvals: [answer('i1', 2, { answerText: '\n\n keep it \n\n' })],
    version: 1,
    exclude: undefined,
    expected: [{ run: 2, approved: false, text: 'keep it' }],
  },
]

describe('planAnswers', () => {
  it.each(ANSWERS)('$name', ({ approvals, version, exclude, expected }) => {
    expect(planAnswers(approvals, version, exclude)).toEqual(expected)
  })
})
