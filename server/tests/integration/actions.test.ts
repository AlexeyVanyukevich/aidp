import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const act = (taskId: string, action: string) =>
  app.inject({ method: 'POST', url: `/api/tasks/${taskId}/actions/${action}` })
const run = (runId: string) =>
  getTestDb().selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow()

describe('Cancel', () => {
  it('cancels a queued run outright', async () => {
    const { taskId, runId } = await seedQueuedRun(getTestDb())
    expect((await act(taskId, 'cancel')).json().state).toBe('failed')
    expect(await run(runId)).toMatchObject({
      status: 'cancelled',
      failure_reason: 'cancelled by the owner',
    })
  })

  it('asks the runner to stop a running run', async () => {
    const { taskId, runId } = await seedQueuedRun(getTestDb())
    await getTestDb()
      .updateTable('runs')
      .set({ status: 'running' })
      .where('id', '=', runId)
      .execute()
    await getTestDb()
      .updateTable('tasks')
      .set({ state: 'running' })
      .where('id', '=', taskId)
      .execute()
    expect((await act(taskId, 'cancel')).json().state).toBe('failed')
    expect(await run(runId)).toMatchObject({ status: 'running', cancel_requested: true })
  })

  it('answers 409 for a card with nothing to cancel', async () => {
    const { taskId } = await seedQueuedRun(getTestDb(), { state: 'review' })
    expect((await act(taskId, 'cancel')).statusCode).toBe(409)
  })
})

describe('Re-run', () => {
  it('queues a new delivery run of the approved spec', async () => {
    const { taskId } = await seedQueuedRun(getTestDb(), { state: 'failed' })
    expect((await act(taskId, 'rerun')).json().state).toBe('ready')
    const runs = await getTestDb()
      .selectFrom('runs')
      .select(['status', 'spec_version'])
      .where('task_id', '=', taskId)
      .orderBy('created_at')
      .execute()
    expect(runs).toEqual([
      { status: 'queued', spec_version: 1 },
      { status: 'queued', spec_version: 1 },
    ])
  })

  it('refuses an unknown action', async () => {
    const { taskId } = await seedQueuedRun(getTestDb())
    expect((await act(taskId, 'deploy')).statusCode).toBe(400)
  })
})
