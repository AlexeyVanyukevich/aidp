import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'
import { GOOD_SPEC, seedQueuedRun } from './fixtures.js'

let app: FastifyInstance
const auth = { authorization: `Bearer ${TEST_RUNNER_KEY}` }
const db = () => getTestDb()

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const REASON = 'verify failed on attempt 3, after 2 Verify runs: AC4'

/** A Failed task with an approved v1 and two failed delivery runs (AIDP-55). */
async function failedTask(state: 'failed' | 'ready' = 'failed') {
  const seeded = await seedQueuedRun(db(), { state })
  await db()
    .updateTable('specs')
    .set({ approval_note: 'Mind the cap.' })
    .where('task_id', '=', seeded.taskId)
    .execute()
  await db()
    .updateTable('runs')
    .set({ status: 'failed', ended_at: new Date(), failure_reason: 'first' })
    .where('id', '=', seeded.runId)
    .execute()
  await db()
    .insertInto('runs')
    .values({
      task_id: seeded.taskId,
      kind: 'delivery',
      number: 2,
      spec_version: 1,
      status: 'failed',
      ended_at: new Date(),
      failure_reason: REASON,
    })
    .execute()
  return seeded.taskId
}

const redraft = (taskId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/tasks/${taskId}/actions/redraft`, payload })
const stateOf = async (taskId: string) =>
  (
    await db()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
  ).state
const runsOf = (taskId: string) =>
  db()
    .selectFrom('runs')
    .select(['kind', 'number', 'spec_version', 'note', 'status'])
    .where('task_id', '=', taskId)
    .orderBy('created_at')
    .execute()
const getTask = async (taskId: string) =>
  (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json()

describe('Redraft from Failed', () => {
  it('queues one spec run on the approved version and leaves the history alone', async () => {
    const taskId = await failedTask()
    const before = await runsOf(taskId)
    const response = await redraft(taskId, { note: '  AC4 cannot fail on the base  ' })
    expect(response.statusCode).toBe(200)
    expect(await stateOf(taskId)).toBe('spec_draft')
    expect(await runsOf(taskId)).toEqual([
      ...before,
      {
        kind: 'spec',
        number: 1,
        spec_version: 1,
        note: 'AC4 cannot fail on the base',
        status: 'queued',
      },
    ])
    const spec = await db().selectFrom('specs').selectAll().executeTakeFirstOrThrow()
    expect(spec).toMatchObject({ status: 'approved', approval_note: 'Mind the cap.' })
  })

  it('refuses a blank note, keeps the card Failed and adds no run', async () => {
    const taskId = await failedTask()
    const before = await runsOf(taskId)
    const response = await redraft(taskId, { note: '   ' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: 'validation_error',
      details: { field: 'note' },
    })
    expect(await stateOf(taskId)).toBe('failed')
    expect(await runsOf(taskId)).toEqual(before)
  })

  it('refuses a note over 4 000 characters', async () => {
    const taskId = await failedTask()
    expect((await redraft(taskId, { note: 'x'.repeat(4001) })).statusCode).toBe(400)
    expect(await stateOf(taskId)).toBe('failed')
  })

  it('refuses a Ready card with a conflict', async () => {
    const taskId = await failedTask('ready')
    expect((await redraft(taskId, { note: 'x' })).statusCode).toBe(409)
  })
})

describe('Save by hand from Failed', () => {
  it('writes a draft v2, keeps v1 approved and moves the card to Spec review', async () => {
    const taskId = await failedTask()
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/specs`,
      payload: { body_md: GOOD_SPEC.replace('back off', 'back off, capped') },
    })
    expect(response.statusCode).toBe(201)
    const specs = await db()
      .selectFrom('specs')
      .select(['version', 'status', 'approval_note'])
      .orderBy('version')
      .execute()
    expect(specs).toEqual([
      { version: 1, status: 'approved', approval_note: 'Mind the cap.' },
      { version: 2, status: 'draft', approval_note: null },
    ])
    expect(await stateOf(taskId)).toBe('spec_review')
  })
})

describe('A redraft from Failed that ends without a new version', () => {
  async function drafting() {
    const taskId = await failedTask()
    const planBefore = (await getTask(taskId)).plan_to_keep
    await redraft(taskId, { note: 'AC4 is wrong' })
    const work = (
      await app.inject({
        method: 'POST',
        url: '/api/runner/claim',
        headers: auth,
        payload: { runner_id: 'r1', wait_ms: 0 },
      })
    ).json().work
    return { taskId, planBefore, work }
  }
  const runEnd = async (runId: string, payload: Record<string, unknown>) => {
    const token = (
      await app.inject({ method: 'POST', url: `/api/runner/runs/${runId}/tokens`, headers: auth })
    ).json().token as string
    return app.inject({
      method: 'POST',
      url: '/api/runner/events',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        events: [
          {
            id: crypto.randomUUID(),
            run_id: runId,
            phase_id: null,
            ts: new Date().toISOString(),
            type: 'run_end',
            agent: null,
            model: null,
            tool: null,
            target: null,
            status: null,
            duration_ms: null,
            usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            payload,
          },
        ],
      },
    })
  }

  it('goes back to Failed when the owner cancels it', async () => {
    const { taskId, planBefore } = await drafting()
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/actions/cancel`,
    })
    expect(response.json().state).toBe('failed')
    expect((await getTask(taskId)).plan_to_keep).toEqual(planBefore)
  })

  it('goes back to Failed when the runner reports it ended with no saved version', async () => {
    const { taskId, planBefore, work } = await drafting()
    await runEnd(work.run.id, { outcome: 'drafted' })
    expect(await stateOf(taskId)).toBe('failed')
    expect((await getTask(taskId)).plan_to_keep).toEqual(planBefore)
  })

  it('goes to Spec review when it saved a version before it failed', async () => {
    const { taskId, work } = await drafting()
    await db()
      .insertInto('specs')
      .values({
        task_id: taskId,
        version: 2,
        body_md: GOOD_SPEC,
        status: 'draft',
        criteria: null,
        run_id: work.run.id,
      })
      .execute()
    await runEnd(work.run.id, { outcome: 'failed', reason: 'the spec phase failed' })
    expect(await stateOf(taskId)).toBe('spec_review')
  })
})
