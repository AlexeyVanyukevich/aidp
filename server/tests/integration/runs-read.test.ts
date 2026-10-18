import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'

let app: FastifyInstance
let ids: { taskId: string; runId: string }
const PLAN_PHASE = crypto.randomUUID()
const BUILD_PHASE = crypto.randomUUID()
const TS = new Date('2026-10-11T10:00:00Z')

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(async () => {
  await resetDb()
  ids = await seedQueuedRun(getTestDb())
  const db = getTestDb()
  await db
    .updateTable('runs')
    .set({ status: 'running', current_phase: 'build' })
    .where('id', '=', ids.runId)
    .execute()
  await db.updateTable('tasks').set({ state: 'running' }).where('id', '=', ids.taskId).execute()
  await db
    .insertInto('prices')
    .values({
      model: 'm',
      effective_from: '2026-01-01',
      input: 1,
      output: 5,
      cache_read: 0.1,
      cache_write: 2,
    })
    .execute()
  await db
    .insertInto('phases')
    .values([
      {
        id: PLAN_PHASE,
        run_id: ids.runId,
        name: 'plan',
        attempt: 1,
        agent: 'planner',
        model: 'm',
        status: 'succeeded',
        started_at: TS,
        reported_cost: JSON.stringify({ m: 1 }),
      },
      {
        id: BUILD_PHASE,
        run_id: ids.runId,
        name: 'build',
        attempt: 1,
        agent: 'builder',
        model: 'm',
        status: 'running',
        started_at: new Date(TS.getTime() + 60_000),
      },
    ])
    .execute()
  const usage = (input: number) => ({ input, output: 0, cache_read: 0, cache_write: 0 })
  const rows = [
    { phase: PLAN_PHASE, agent: 'planner', model: 'm', ...usage(1_000_000), at: 0, tool: null },
    { phase: BUILD_PHASE, agent: 'builder', model: 'm', ...usage(500_000), at: 1, tool: null },
    { phase: BUILD_PHASE, agent: 'builder', model: null, ...usage(0), at: 2, tool: 'Edit' },
  ]
  await db
    .insertInto('events')
    .values(
      rows.map((row) => ({
        id: crypto.randomUUID(),
        run_id: ids.runId,
        phase_id: row.phase,
        ts: new Date(TS.getTime() + row.at * 1000),
        type: row.model === null ? 'tool_call' : 'message',
        agent: row.agent,
        model: row.model,
        tool: row.tool,
        target: null,
        status: null,
        duration_ms: null,
        input: row.input,
        output: row.output,
        cache_read: row.cache_read,
        cache_write: row.cache_write,
        payload: '{}',
      })),
    )
    .execute()
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('reading a run', () => {
  it('lists the task’s runs with their phases', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${ids.taskId}/runs` })
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: ids.runId,
        number: 1,
        status: 'running',
        phases: [
          expect.objectContaining({ id: PLAN_PHASE, name: 'plan' }),
          expect.objectContaining({ id: BUILD_PHASE, name: 'build' }),
        ],
      }),
    ])
  })

  it('pages through events in time order with a cursor', async () => {
    const first = (
      await app.inject({ method: 'GET', url: `/api/runs/${ids.runId}/events?limit=2` })
    ).json()
    expect(first.events).toHaveLength(2)
    expect(first.next).toEqual(expect.any(String))
    const second = (
      await app.inject({
        method: 'GET',
        url: `/api/runs/${ids.runId}/events?limit=2&after=${encodeURIComponent(first.next)}`,
      })
    ).json()
    expect(second.events.map((e: { tool: string | null }) => e.tool)).toEqual(['Edit'])
    expect(second.next).toBeNull()
  })

  it('summarises the task’s costs', async () => {
    const summary = (
      await app.inject({ method: 'GET', url: `/api/tasks/${ids.taskId}/costs` })
    ).json()
    expect(summary.totals.usd).toBeCloseTo(1.5, 10)
    expect(summary.byPhase[0]).toMatchObject({
      phaseId: PLAN_PHASE,
      usd: 1,
      reportedUsd: 1,
      flagged: false,
    })
    expect(summary.missingPrices).toEqual([])
  })

  it('puts the phase, the models and the cost on the board card', async () => {
    const board = (await app.inject({ method: 'GET', url: '/api/projects/PAY/tasks' })).json()
    expect(board.tasks[0]).toMatchObject({
      state: 'running',
      phase: 'build',
      attempt: 1,
      models: ['m'],
      cost_complete: true,
      pr_url: null,
    })
    expect(board.tasks[0].cost_usd).toBeCloseTo(1.5, 10)
  })

  it('says a card’s cost is incomplete while a model has no price', async () => {
    await getTestDb().deleteFrom('prices').execute()
    const board = (await app.inject({ method: 'GET', url: '/api/projects/PAY/tasks' })).json()
    expect(board.tasks[0]).toMatchObject({ cost_usd: 0, cost_complete: false })
  })
})
