import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'
import { loadPlanHistory } from '../../src/modules/tasks/plan-history.queries.js'
import { planToKeep } from '../../src/modules/tasks/plan-history.js'

beforeEach(resetDb)
afterAll(closeTestDb)

describe('loadPlanHistory', () => {
  it('reads plans of delivery runs and answered plan approvals, and keeps the approved one', async () => {
    const db = getTestDb()
    const { taskId, runId } = await seedQueuedRun(db, { state: 'failed' })
    await db
      .insertInto('artifacts')
      .values({
        run_id: runId,
        phase_id: null,
        kind: 'plan',
        body_md: 'the plan',
        data: JSON.stringify({ confidence: 'medium', steps: [] }),
      })
      .execute()
    await db
      .insertInto('approval_requests')
      .values({
        run_id: runId,
        kind: 'plan',
        question: 'q',
        options: JSON.stringify([]),
        context_md: 'the plan',
        status: 'answered',
        answer: JSON.stringify({ option_id: 'approve', text: 'and words' }),
        answered_at: new Date(),
      })
      .execute()
    const { plans, approvals } = await loadPlanHistory(db, taskId)
    expect(plans).toMatchObject([
      { runNumber: 1, specVersion: 1, confidence: 'medium', bodyMd: 'the plan' },
    ])
    expect(approvals).toMatchObject([
      {
        optionId: 'approve',
        contextMd: 'the plan',
        answerText: 'and words',
        runNumber: 1,
        specVersion: 1,
      },
    ])
    expect(approvals[0]?.answeredAt).toBeInstanceOf(Date)
    expect(typeof approvals[0]?.id).toBe('string')
    expect(planToKeep(plans, approvals, 1)?.runNumber).toBe(1)
  })
})
