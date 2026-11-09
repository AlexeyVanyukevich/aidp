import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HelpService } from '../../src/modules/approvals/help.service.js'
import { moveFacts } from '../../src/modules/tasks/task.moves.js'
import { Sweeper } from '../../src/modules/runs/sweeper.js'
import { seedQueuedRun } from './fixtures.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'

let app: FastifyInstance
let now = new Date('2026-10-20T10:00:00Z')
beforeAll(async () => {
  app = await buildTestApp({ clock: () => now })
})
beforeEach(async () => {
  await resetDb()
  now = new Date('2026-10-20T10:00:00Z')
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})
const db = () => getTestDb()
const runner = { authorization: `Bearer ${TEST_RUNNER_KEY}` }

/** A Failed card with a finished delivery run, and a queued Mark done help beside it. */
async function failedCard() {
  const seeded = await seedQueuedRun(db(), { state: 'failed' })
  await db()
    .updateTable('runs')
    .set({ status: 'failed', failure_reason: 'tests failed', queued_at: null })
    .where('id', '=', seeded.runId)
    .execute()
  return seeded
}
const ask = async (taskId: string) =>
  (
    await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/helps`,
      payload: { decision: 'mark_done', mode: 'check' },
    })
  ).json() as { id: string }
const helpRun = (taskId: string) =>
  db()
    .selectFrom('runs')
    .selectAll()
    .where('task_id', '=', taskId)
    .where('kind', '=', 'help')
    .executeTakeFirstOrThrow()
const service = () => new HelpService(db(), app.bus, () => now)

describe('the claim', () => {
  it('refuses the help kind and never returns a help run (AC8)', async () => {
    const { taskId } = await failedCard()
    await ask(taskId)
    const refused = await app.inject({
      method: 'POST',
      url: '/api/runner/claim',
      headers: runner,
      payload: { runner_id: 'r1', wait_ms: 0, kinds: ['help'] },
    })
    expect(refused.statusCode).toBe(400)
    expect(refused.body).toContain('kinds')
    const plain = await app.inject({
      method: 'POST',
      url: '/api/runner/claim',
      headers: runner,
      payload: { runner_id: 'r1', wait_ms: 0 },
    })
    expect(plain.json().work).toBeNull()
    expect((await helpRun(taskId)).status).toBe('queued')
  })
})

describe('a help run ends with its help', () => {
  it('is failed with the help reason (AC9)', async () => {
    const { taskId } = await failedCard()
    const help = await ask(taskId)
    await db()
      .updateTable('helps')
      .set({ status: 'running', runner_id: 'r1' })
      .where('id', '=', help.id)
      .execute()
    await service().fail(help.id, 'the helper broke')
    const run = await helpRun(taskId)
    expect(run).toMatchObject({ status: 'failed', failure_reason: 'the helper broke' })
  })

  it('is cancelled when the card moves on (AC9)', async () => {
    const { taskId } = await failedCard()
    await ask(taskId)
    const moved = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/actions/rerun` })
    expect(moved.statusCode).toBe(200)
    expect((await helpRun(taskId)).status).toBe('cancelled')
  })
})

describe('the card ignores help runs (AC10)', () => {
  it('reads the same facts and task view with a help run beside the delivery run', async () => {
    const { taskId } = await failedCard()
    const before = {
      facts: await moveFacts(db(), taskId),
      view: (await app.inject({ url: `/api/tasks/${taskId}` })).json(),
    }
    await ask(taskId)
    const after = {
      facts: await moveFacts(db(), taskId),
      view: (await app.inject({ url: `/api/tasks/${taskId}` })).json(),
    }
    expect(after).toEqual(before)
  })
})

describe('the sweeper', () => {
  it('fails a lost help and its run, and leaves the card (AC11)', async () => {
    const { taskId } = await failedCard()
    const help = await ask(taskId)
    await db()
      .updateTable('helps')
      .set({ status: 'running', runner_id: 'r1', started_at: now, last_heartbeat_at: now })
      .where('id', '=', help.id)
      .execute()
    const sweeper = new Sweeper(db(), () => now, 60_000, { warn: () => undefined })
    now = new Date(now.getTime() + 30_000)
    await sweeper.tick()
    now = new Date(now.getTime() + 61_000)
    await sweeper.tick()
    const row = await db()
      .selectFrom('helps')
      .select('status')
      .where('id', '=', help.id)
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('failed')
    expect((await helpRun(taskId)).status).toBe('failed')
    const task = await db()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
    expect(task.state).toBe('failed')
  })
})
