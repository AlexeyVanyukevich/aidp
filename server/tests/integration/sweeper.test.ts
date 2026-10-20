import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedRunningRun } from './fixtures.js'
import { openApproval } from '../../src/modules/approvals/approval.service.js'
import { Sweeper } from '../../src/modules/runs/sweeper.js'

const MIN = 60_000
let now = new Date('2026-10-20T10:00:00Z')
const later = (ms: number) => (now = new Date(now.getTime() + ms))
const quiet = { warn: () => undefined }
let app: FastifyInstance

beforeAll(async () => {
  // The app is here for its bus: the test listens for the notices a sweep sends.
  app = await buildTestApp()
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
const sweeper = () => new Sweeper(db(), () => now, MIN, quiet)
const state = async (taskId: string) =>
  (
    await db()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
  ).state
const run = (id: string) =>
  db().selectFrom('runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

async function silentRun() {
  const seeded = await seedRunningRun(db())
  await db()
    .updateTable('runs')
    .set({ last_heartbeat_at: now })
    .where('id', '=', seeded.runId)
    .execute()
  return seeded
}

describe('the sweeper', () => {
  it('blocks a run whose runner went silent, pausing its phase as interrupted', async () => {
    const { runId, taskId, phaseId } = await silentRun()
    const sweep = sweeper()
    await sweep.tick() // arms
    later(MIN + 31_000)
    const updated = app.bus.next('task.updated', 2_000)
    await sweep.tick()

    expect(await run(runId)).toMatchObject({
      status: 'blocked',
      block: { cause: 'runner_lost', stage: 'build' },
    })
    expect(await state(taskId)).toBe('blocked')
    const phase = await db()
      .selectFrom('phases')
      .select(['status', 'interrupted'])
      .where('id', '=', phaseId)
      .executeTakeFirstOrThrow()
    expect(phase).toEqual({ status: 'paused', interrupted: true })
    expect(await updated).toEqual({ topic: 'task.updated', taskId })
  })

  it('leaves a run that is still reporting', async () => {
    const { runId } = await silentRun()
    const sweep = sweeper()
    await sweep.tick()
    later(MIN)
    await db().updateTable('runs').set({ last_heartbeat_at: now }).where('id', '=', runId).execute()
    later(MIN)
    await sweep.tick()
    expect((await run(runId)).status).toBe('running')
  })

  it('expires a question left open for 48 hours, blocking the card', async () => {
    const seeded = await seedRunningRun(db())
    const { id } = await db()
      .transaction()
      .execute((trx) =>
        openApproval(
          trx,
          {
            runId: seeded.runId,
            taskId: seeded.taskId,
            phaseId: seeded.phaseId,
            kind: 'question',
            question: 'Which colour?',
            options: [],
          },
          now,
          { recordEvent: true },
        ),
      )
    const sweep = sweeper()
    later(48 * 60 * MIN - MIN)
    await sweep.tick() // arms
    later(MIN)
    await sweep.tick()

    const approval = await db()
      .selectFrom('approval_requests')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(approval.status).toBe('expired')
    expect(await run(seeded.runId)).toMatchObject({
      status: 'blocked',
      block: { cause: 'approval_expired', stage: 'build' },
    })
    expect(await state(seeded.taskId)).toBe('blocked')
  })

  it('decides nothing on its first tick', async () => {
    const { runId } = await silentRun()
    later(10 * MIN)
    await sweeper().tick()
    expect((await run(runId)).status).toBe('running')
  })

  it('decides nothing on the tick after a sleep, and acts on the next', async () => {
    const { runId } = await silentRun()
    const sweep = sweeper()
    await sweep.tick()
    later(10 * MIN) // the machine slept
    await sweep.tick()
    expect((await run(runId)).status).toBe('running')
    later(MIN)
    await sweep.tick()
    expect((await run(runId)).status).toBe('blocked')
  })
})
