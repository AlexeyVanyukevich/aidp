import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'
import { seedProject, seedQueuedRun, seedTask } from './fixtures.js'
import { Sweeper } from '../../src/modules/runs/sweeper.js'
import type { TaskState } from '../../src/shared/vocabulary.js'

const MIN = 60_000
let now = new Date('2026-10-20T10:00:00Z')
let app: FastifyInstance
let base: string
const auth = { authorization: `Bearer ${TEST_RUNNER_KEY}` }
const db = () => getTestDb()

beforeAll(async () => {
  app = await buildTestApp({ clock: () => now })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(async () => {
  await resetDb()
  now = new Date('2026-10-20T10:00:00Z')
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const text = (result: unknown) =>
  ((result as { content: { text: string }[] }).content[0] as { text: string }).text
const runRow = (id: string) =>
  db().selectFrom('runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
const stateOf = async (taskId: string) =>
  (
    await db()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
  ).state

/** A task with a claimed rephrase run and a running phase, and an MCP client on its token. */
async function rephraseSession(
  options: { state?: TaskState; phase?: 'running' | 'succeeded'; budget?: number } = {},
) {
  const project = await seedProject(db())
  const task = await seedTask(db(), project.id, { state: options.state ?? 'backlog' })
  if (options.budget !== undefined)
    await db().updateTable('tasks').set({ budget_usd: options.budget }).execute()
  const run = await db()
    .insertInto('runs')
    .values({
      task_id: task.id,
      kind: 'rephrase',
      number: 1,
      status: 'queued',
      queued_at: now,
      base_md: 'The base.',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/runner/claim',
    headers: auth,
    payload: { runner_id: 'r1', kinds: ['rephrase'] },
  })
  const phaseId = crypto.randomUUID()
  await db()
    .insertInto('phases')
    .values({
      id: phaseId,
      run_id: run.id,
      name: 'rephrase',
      attempt: 1,
      agent: 'rephraser',
      model: 'sonnet',
      status: options.phase ?? 'running',
      started_at: now,
    })
    .execute()
  const token = (
    await app.inject({
      method: 'POST',
      url: `/api/runner/runs/${run.id}/tokens`,
      headers: auth,
    })
  ).json().token as string
  return { taskId: task.id, runId: run.id, phaseId, token, claimed }
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }) as Transport,
  )
  return client
}
const save = (client: Client, body_md: string) =>
  client.callTool({ name: 'save_suggestion', arguments: { body_md } })

describe('save_suggestion', () => {
  it('overwrites the run’s suggestion, leaves its status null, and answers in words', async () => {
    const { token, runId } = await rephraseSession()
    const client = await connect(token)
    expect(text(await save(client, 'First'))).toBe('Saved the suggestion.')
    expect(text(await save(client, 'Second'))).toBe('Saved the suggestion.')
    expect(await runRow(runId)).toMatchObject({ suggestion_md: 'Second', suggestion_status: null })
  })

  it('is refused when the phase is not running', async () => {
    const { token, runId } = await rephraseSession({ phase: 'succeeded' })
    const result = await save(await connect(token), 'Late')
    expect(result.isError).toBe(true)
    expect((await runRow(runId)).suggestion_md).toBeNull()
  })

  it.each([
    ['empty', ''],
    ['over the description’s limit', 'x'.repeat(100_001)],
  ])('refuses a body that is %s', async (_name, body) => {
    const { token, runId } = await rephraseSession()
    const result = await save(await connect(token), body)
    expect(result.isError).toBe(true)
    expect((await runRow(runId)).suggestion_md).toBeNull()
  })

  it('is refused for a delivery run’s token, and saves nothing', async () => {
    const seeded = await seedQueuedRun(db())
    await app.inject({
      method: 'POST',
      url: '/api/runner/claim',
      headers: auth,
      payload: { runner_id: 'r1' },
    })
    const token = (
      await app.inject({
        method: 'POST',
        url: `/api/runner/runs/${seeded.runId}/tokens`,
        headers: auth,
      })
    ).json().token as string
    await db()
      .insertInto('phases')
      .values({
        id: crypto.randomUUID(),
        run_id: seeded.runId,
        name: 'plan',
        attempt: 1,
        agent: 'planner',
        model: 'opus',
        status: 'running',
        started_at: now,
      })
      .execute()
    const result = await save(await connect(token), 'Nope')
    expect(result.isError).toBe(true)
    expect((await runRow(seeded.runId)).suggestion_md).toBeNull()
  })
})

describe('the end of a rephrase run', () => {
  const send = (token: string, runId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/runner/events',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        events: [
          {
            id: crypto.randomUUID(),
            run_id: runId,
            phase_id: null,
            ts: now.toISOString(),
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

  it.each<[string, Record<string, unknown>, boolean, string, string | null, string | null]>([
    ['suggested, with a suggestion', { outcome: 'suggested' }, true, 'succeeded', null, 'pending'],
    [
      'suggested, without one',
      { outcome: 'suggested' },
      false,
      'failed',
      'the rephraser saved no suggestion',
      null,
    ],
    [
      'failed',
      { outcome: 'failed', reason: 'the rephrase phase failed' },
      true,
      'failed',
      'the rephrase phase failed',
      null,
    ],
    ['cancelled', { outcome: 'cancelled' }, true, 'cancelled', null, null],
  ])(
    'a run_end %s ends the run and moves no card',
    async (_name, payload, saves, status, reason, suggestionStatus) => {
      const { token, runId, taskId } = await rephraseSession({ state: 'spec_review' })
      if (saves)
        await db().updateTable('runs').set({ suggestion_md: 'S' }).where('id', '=', runId).execute()
      const updated = app.bus.next('task.updated', 2_000)
      expect((await send(token, runId, payload)).statusCode).toBe(200)
      expect(await runRow(runId)).toMatchObject({
        status,
        failure_reason: reason,
        suggestion_status: suggestionStatus,
      })
      expect(await updated).toEqual({ topic: 'task.updated', taskId })
      expect(await stateOf(taskId)).toBe('spec_review')
    },
  )

  it.each<[string, Record<string, unknown>]>([
    ['cancelled', { outcome: 'cancelled' }],
    ['suggested', { outcome: 'suggested' }],
    ['failed', { outcome: 'failed', reason: 'the rephrase phase failed' }],
  ])('a late run_end %s leaves a run that has already ended', async (_name, payload) => {
    const { token, runId } = await rephraseSession({ state: 'backlog' })
    await db()
      .updateTable('runs')
      .set({
        status: 'failed',
        failure_reason: 'the runner was lost',
        ended_at: now,
        suggestion_md: 'S',
      })
      .where('id', '=', runId)
      .execute()
    expect((await send(token, runId, payload)).statusCode).toBe(200)
    expect(await runRow(runId)).toMatchObject({
      status: 'failed',
      failure_reason: 'the runner was lost',
      suggestion_status: null,
    })
  })

  it('shows a succeeded run’s suggestion on the card', async () => {
    const { token, runId, taskId } = await rephraseSession()
    await db().updateTable('runs').set({ suggestion_md: 'S' }).where('id', '=', runId).execute()
    await send(token, runId, { outcome: 'suggested' })
    const view = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json()
    expect(view.rephrase).toEqual({
      status: 'succeeded',
      failure_reason: null,
      suggestion: { body_md: 'S', stale: true },
    })
  })
})

describe('a rephrase run’s claim and heartbeat', () => {
  it('carries the task’s budget', async () => {
    const { claimed } = await rephraseSession({ budget: 3 })
    expect(claimed.json().work.run).toMatchObject({
      kind: 'rephrase',
      task: { budget_usd: 3 },
    })
  })

  it('asks the runner to stop it once it is no longer running', async () => {
    const { runId } = await rephraseSession()
    const beat = async () =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/runner/heartbeat',
          headers: auth,
          payload: { runner_id: 'r1', run_ids: [runId] },
        })
      ).json()
    expect((await beat()).cancel).toEqual([])
    await db()
      .updateTable('runs')
      .set({ status: 'failed', failure_reason: 'the runner was lost' })
      .where('id', '=', runId)
      .execute()
    expect((await beat()).cancel).toEqual([runId])
  })
})

describe('the sweeper and a rephrase run', () => {
  it('fails a lost run, interrupts its phase, queues a cleanup and leaves the card', async () => {
    const { runId, taskId, phaseId } = await rephraseSession({ state: 'spec_review' })
    const sweep = new Sweeper(db(), () => now, MIN, { warn: () => undefined })
    await sweep.tick()
    now = new Date(now.getTime() + MIN + 31_000)
    const updated = app.bus.next('task.updated', 2_000)
    await sweep.tick()
    expect(await runRow(runId)).toMatchObject({
      status: 'failed',
      failure_reason: 'the runner was lost',
      block: null,
      pending: 'cleanup',
    })
    const phase = await db()
      .selectFrom('phases')
      .select(['status', 'interrupted'])
      .where('id', '=', phaseId)
      .executeTakeFirstOrThrow()
    expect(phase).toEqual({ status: 'failed', interrupted: true })
    expect(await updated).toEqual({ topic: 'task.updated', taskId })
    expect(await stateOf(taskId)).toBe('spec_review')
  })
})

describe('the cost of a rephrase run', () => {
  it('is part of the task’s total, the Rephrase phase is listed, and the board counts it', async () => {
    const { runId, taskId, phaseId } = await rephraseSession()
    await db()
      .insertInto('prices')
      .values({
        model: 'sonnet',
        effective_from: '2026-01-01',
        input: 1,
        output: 5,
        cache_read: 0.1,
        cache_write: 2,
      })
      .execute()
    await db()
      .insertInto('events')
      .values({
        id: crypto.randomUUID(),
        run_id: runId,
        phase_id: phaseId,
        ts: now,
        type: 'message',
        agent: 'rephraser',
        model: 'sonnet',
        tool: null,
        target: null,
        status: null,
        duration_ms: null,
        input: 1_000_000,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        payload: '{}',
      })
      .execute()
    const summary = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/costs` })).json()
    expect(summary.totals.usd).toBeCloseTo(1, 10)
    expect(summary.byPhase[0]).toMatchObject({ phaseId, name: 'rephrase' })
    const board = (await app.inject({ method: 'GET', url: '/api/projects/PAY/tasks' })).json()
    expect(board.tasks[0].cost_usd).toBeCloseTo(1, 10)
  })
})
