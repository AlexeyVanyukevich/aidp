import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BlockCause, TaskState } from '../../src/shared/vocabulary.js'
import {
  DECISIONS,
  offeredDecisions,
  recommendableActions,
  stands,
  stoppedRunActions,
  type Decision,
  type DecisionFacts,
  type StoppedRunAction,
  type SubjectFacts,
} from '../../src/modules/approvals/decision-rules.js'

interface Row {
  name: string
  state: TaskState
  block_cause: BlockCause | null
  plan_to_keep: boolean
  checkpoint: boolean
  approval_current: boolean
  offered: Decision[]
  stopped_run_actions: StoppedRunAction[]
  recommendable_actions: StoppedRunAction[]
}
const rows = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/decisions.json', import.meta.url), 'utf8'),
) as Row[]

const factsOf = (row: Row): DecisionFacts => ({
  taskState: row.state,
  blockCause: row.block_cause,
  planToKeep: row.plan_to_keep,
  checkpoint: row.checkpoint,
  approvalCurrent: row.approval_current,
})

describe('the decision rules, on the shared table', () => {
  it.each(rows)('$name: offered', (row) => {
    expect(offeredDecisions(factsOf(row))).toEqual(row.offered)
  })
  it.each(rows)('$name: stopped-run actions', (row) => {
    expect(stoppedRunActions(factsOf(row))).toEqual(row.stopped_run_actions)
  })
  it.each(rows)('$name: recommendable actions', (row) => {
    expect(recommendableActions(factsOf(row))).toEqual(row.recommendable_actions)
  })
  it('lists the four decisions', () => {
    expect(DECISIONS).toEqual(['question', 'spec_review', 'stopped_run', 'mark_done'])
  })
})

const base: SubjectFacts = {
  taskState: 'spec_review',
  blockCause: null,
  planToKeep: false,
  checkpoint: false,
  approvalCurrent: false,
  latestSpecVersion: 3,
  approvedSpecVersion: null,
  latestRunId: null,
  latestDeliveryRunId: null,
  runBlock: null,
}

describe('stands', () => {
  const cases: {
    name: string
    decision: 'spec_review' | 'stopped_run' | 'mark_done'
    subject: Parameters<typeof stands>[1]
    facts: SubjectFacts
    expected: boolean
  }[] = [
    {
      name: 'the same version',
      decision: 'spec_review',
      subject: { spec_version: 3 },
      facts: base,
      expected: true,
    },
    {
      name: 'a newer version',
      decision: 'spec_review',
      subject: { spec_version: 3 },
      facts: { ...base, latestSpecVersion: 4 },
      expected: false,
    },
    {
      name: 'the card left Spec review',
      decision: 'spec_review',
      subject: { spec_version: 3 },
      facts: { ...base, taskState: 'ready' },
      expected: false,
    },
    {
      name: 'a stopped run that is still blocked the same way',
      decision: 'stopped_run',
      subject: { run_id: 'r1', task_state: 'blocked', block: 'step_failed' },
      facts: {
        ...base,
        taskState: 'blocked',
        blockCause: 'step_failed',
        latestRunId: 'r1',
        runBlock: 'step_failed',
      },
      expected: true,
    },
    {
      name: 'a stopped run that was resumed and blocked again with another cause',
      decision: 'stopped_run',
      subject: { run_id: 'r1', task_state: 'blocked', block: 'step_failed' },
      facts: {
        ...base,
        taskState: 'blocked',
        blockCause: 'runner_lost',
        latestRunId: 'r1',
        runBlock: 'runner_lost',
      },
      expected: false,
    },
    {
      name: 'Mark done after a new delivery run',
      decision: 'mark_done',
      subject: { task_state: 'review', spec_version: 2, delivery_run_id: 'a' },
      facts: { ...base, taskState: 'review', approvedSpecVersion: 2, latestDeliveryRunId: 'b' },
      expected: false,
    },
    {
      name: 'Mark done unchanged',
      decision: 'mark_done',
      subject: { task_state: 'review', spec_version: 2, delivery_run_id: 'a' },
      facts: { ...base, taskState: 'review', approvedSpecVersion: 2, latestDeliveryRunId: 'a' },
      expected: true,
    },
  ]
  it.each(cases)('$name', ({ decision, subject, facts, expected }) => {
    expect(stands(decision, subject, facts)).toBe(expected)
  })
})
