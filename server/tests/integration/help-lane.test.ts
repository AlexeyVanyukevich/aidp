import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TaskState } from '../../src/shared/vocabulary.js'
import { seedQueuedRun } from './fixtures.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})
const db = () => getTestDb()
const runner = { authorization: `Bearer ${TEST_RUNNER_KEY}` }

type CardDecision = 'spec_review' | 'stopped_run' | 'mark_done'

const ask = (taskId: string, decision: CardDecision, mode: string) =>
  app.inject({ method: 'POST', url: `/api/tasks/${taskId}/helps`, payload: { decision, mode } })
const claim = async () =>
  (
    await app.inject({
      method: 'POST',
      url: '/api/runner/helps/claim',
      headers: runner,
      payload: { runner_id: 'r1', wait_ms: 0 },
    })
  ).json().help as Record<string, any> | null

describe('claiming a decision help', () => {
  const rows: {
    name: string
    state: TaskState
    run: 'succeeded' | 'blocked' | 'failed' | null
    decision: CardDecision
    mode: string
    checkout: Record<string, unknown>
  }[] = [
    {
      name: 'Mark done in Review reads the pull-request branch',
      state: 'review',
      run: 'succeeded',
      decision: 'mark_done',
      mode: 'check',
      checkout: { source: 'pr_branch', branch: 'board/PAY-1-r1' },
    },
    {
      name: 'a Blocked run reads its own worktree',
      state: 'blocked',
      run: 'blocked',
      decision: 'stopped_run',
      mode: 'recommend',
      checkout: { source: 'paused_run' },
    },
    {
      name: 'a Failed run reads the base branch',
      state: 'failed',
      run: 'failed',
      decision: 'stopped_run',
      mode: 'recommend',
      checkout: { source: 'base' },
    },
    {
      name: 'a spec review reads the base branch',
      state: 'spec_review',
      run: null,
      decision: 'spec_review',
      mode: 'review',
      checkout: { source: 'base' },
    },
  ]
  it.each(rows)('$name (AC13)', async (row) => {
    const card = await seedQueuedRun(db(), { state: row.state })
    if (row.run === null) {
      await db().deleteFrom('runs').where('id', '=', card.runId).execute()
      await db().updateTable('specs').set({ status: 'draft' }).execute()
    } else
      await db()
        .updateTable('runs')
        .set({
          status: row.run,
          queued_at: null,
          ...(row.run === 'blocked'
            ? { block: JSON.stringify({ cause: 'runner_lost', stage: 'build' }) }
            : {}),
        })
        .where('id', '=', card.runId)
        .execute()
    expect((await ask(card.taskId, row.decision, row.mode)).statusCode).toBe(201)
    const work = await claim()
    expect(work).toMatchObject({
      decision: row.decision,
      mode: row.mode,
      attempt: 1,
      run: { number: 1, task: { key: 'PAY-1' } },
      decision_work: {
        repo_path: '/repos/PAY',
        base_branch: 'main',
        links: [],
        checkout: row.checkout,
      },
    })
    if (row.checkout.source === 'paused_run')
      expect(work!.decision_work.checkout.run_id).toBe(card.runId)
    const helpRun = await db()
      .selectFrom('runs')
      .select(['id', 'kind', 'status'])
      .where('kind', '=', 'help')
      .executeTakeFirstOrThrow()
    expect(work!.run.id).toBe(helpRun.id)
    expect(helpRun.status).toBe('queued')
  })
})

describe('POST /api/runner/helps/ended', () => {
  it('names only the help runs that have ended (AC39)', async () => {
    const card = await seedQueuedRun(db(), { state: 'failed' })
    await db()
      .updateTable('runs')
      .set({ status: 'failed', queued_at: null })
      .where('id', '=', card.runId)
      .execute()
    await ask(card.taskId, 'mark_done', 'check')
    const queued = await db()
      .selectFrom('runs')
      .select('id')
      .where('kind', '=', 'help')
      .executeTakeFirstOrThrow()
    const other = await db()
      .insertInto('runs')
      .values({
        task_id: card.taskId,
        kind: 'help',
        number: 2,
        status: 'cancelled',
        queued_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runner/helps/ended',
      headers: runner,
      payload: { run_ids: [queued.id, other.id, card.runId, crypto.randomUUID()] },
    })
    expect(response.json()).toEqual({ ended: [other.id] })
    const refused = await app.inject({
      method: 'POST',
      url: '/api/runner/helps/ended',
      headers: runner,
      payload: { run_ids: [], extra: 1 },
    })
    expect(refused.statusCode).toBe(400)
  })
})
