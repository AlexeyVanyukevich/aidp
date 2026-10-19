import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'
import { publish } from '../../src/shared/bus.js'

let app: FastifyInstance
let now = new Date('2026-10-11T10:00:00Z')
const auth = { authorization: `Bearer ${TEST_RUNNER_KEY}` }

beforeAll(async () => {
  app = await buildTestApp({ clock: () => now })
})
beforeEach(async () => {
  await resetDb()
  now = new Date('2026-10-11T10:00:00Z')
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const claim = (wait_ms = 0) =>
  app.inject({
    method: 'POST',
    url: '/api/runner/claim',
    headers: auth,
    payload: { runner_id: 'r1', wait_ms },
  })

async function claimed() {
  const seeded = await seedQueuedRun(getTestDb())
  await claim()
  const token = (
    await app.inject({
      method: 'POST',
      url: `/api/runner/runs/${seeded.runId}/tokens`,
      headers: auth,
    })
  ).json().token as string
  return { ...seeded, token }
}

function event(
  runId: string,
  type: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id: crypto.randomUUID(),
    run_id: runId,
    phase_id: null,
    ts: now.toISOString(),
    type,
    agent: null,
    model: null,
    tool: null,
    target: null,
    status: null,
    duration_ms: null,
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    payload,
    ...extra,
  }
}

const send = (token: string, events: unknown[]) =>
  app.inject({
    method: 'POST',
    url: '/api/runner/events',
    headers: { authorization: `Bearer ${token}` },
    payload: { events },
  })

const state = async (taskId: string) =>
  (
    await getTestDb()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
  ).state

describe('the runner key', () => {
  it.each([
    ['no header', {}],
    ['the wrong key', { authorization: `Bearer ${'x'.repeat(40)}` }],
    ['another scheme', { authorization: `Basic ${TEST_RUNNER_KEY}` }],
  ])('answers %s with one identical 401', async (_name, headers) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/runner/claim',
      headers,
      payload: { runner_id: 'r1' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: 'unauthorized',
      message: 'Missing or invalid credential',
    })
  })

  // The credential is checked before the body is read: a caller without one learns nothing of
  // the body's shape, whatever it sends.
  const RUN = '00000000-0000-4000-8000-000000000001'
  const routes = [
    '/api/runner/claim',
    '/api/runner/heartbeat',
    `/api/runner/runs/${RUN}/tokens`,
    '/api/runner/events',
    '/api/runner/tokens/retire',
  ]
  const credentials: [string, Record<string, string>][] = [
    ['no header', {}],
    ['a wrong secret', { authorization: `Bearer ${'x'.repeat(40)}` }],
  ]
  it.each(
    routes.flatMap((url) => credentials.map(([name, headers]) => [url, name, headers] as const)),
  )('answers %s with %s and an empty body with the same 401', async (url, _name, headers) => {
    const response = await app.inject({ method: 'POST', url, headers, payload: {} })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: 'unauthorized',
      message: 'Missing or invalid credential',
    })
  })
})

describe('POST /api/runner/claim', () => {
  it('answers no work when nothing is queued', async () => {
    expect((await claim()).json()).toEqual({ work: null })
  })

  it('hands over the oldest queued run with everything the runner needs, once', async () => {
    const { taskId, runId } = await seedQueuedRun(getTestDb())
    const work = (await claim()).json().work
    expect(work).toMatchObject({
      kind: 'start',
      run: {
        id: runId,
        number: 1,
        kind: 'delivery',
        spec_version: 1,
        task: { id: taskId, key: 'PAY-1', title: 'Retry webhooks', budget_usd: null },
        spec: { version: 1, criteria: [{ id: 'AC1' }] },
        project: {
          key: 'PAY',
          repo_path: '/repos/PAY',
          github_repo: 'owner/pay',
          base_branch: 'main',
          test_command: 'npm test',
        },
      },
    })
    expect(await state(taskId)).toBe('running')
    expect((await claim()).json()).toEqual({ work: null })
  })

  it('waits for work when asked to, and answers as soon as a run is queued', async () => {
    const pending = claim(5_000)
    await new Promise((done) => setTimeout(done, 200))
    // Seeded directly, so the test publishes what Task 10's queueDeliveryRun publishes.
    const { runId } = await seedQueuedRun(getTestDb())
    await publish(getTestDb(), { topic: 'run.queued', runId })
    expect((await pending).json().work.run.id).toBe(runId)
  })

  it('cancels a queued run whose task was cancelled, instead of handing it over', async () => {
    const { runId } = await seedQueuedRun(getTestDb(), { state: 'failed' })
    expect((await claim()).json()).toEqual({ work: null })
    const run = await getTestDb()
      .selectFrom('runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run.status).toBe('cancelled')
  })
})

describe('run tokens', () => {
  it('accept events for their own run', async () => {
    const { runId, token } = await claimed()
    expect((await send(token, [event(runId, 'message', {})])).json()).toEqual({ accepted: 1 })
  })

  it('refuse events for another run', async () => {
    const { token } = await claimed()
    const response = await send(token, [event(crypto.randomUUID(), 'message', {})])
    expect(response.statusCode).toBe(401)
  })

  it('expire twelve hours after issue', async () => {
    const { runId, token } = await claimed()
    now = new Date(now.getTime() + 12 * 3600_000 + 1)
    expect((await send(token, [event(runId, 'message', {})])).statusCode).toBe(401)
  })

  it('stop working five minutes after they are retired', async () => {
    const { runId, token } = await claimed()
    const retired = await app.inject({
      method: 'POST',
      url: '/api/runner/tokens/retire',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(retired.statusCode).toBe(204)
    now = new Date(now.getTime() + 4 * 60_000)
    expect((await send(token, [event(runId, 'message', {})])).statusCode).toBe(200)
    now = new Date(now.getTime() + 2 * 60_000)
    expect((await send(token, [event(runId, 'message', {})])).statusCode).toBe(401)
  })

  it('are issued only for a run that is running', async () => {
    const { runId } = await seedQueuedRun(getTestDb())
    const response = await app.inject({
      method: 'POST',
      url: `/api/runner/runs/${runId}/tokens`,
      headers: auth,
    })
    expect(response.statusCode).toBe(409)
  })
})

describe('POST /api/runner/events', () => {
  it('records a phase from its start and end events, with usage on the events', async () => {
    const { runId, token } = await claimed()
    const phaseId = crypto.randomUUID()
    await send(token, [
      event(
        runId,
        'phase_start',
        { name: 'plan', attempt: 1, session_id: crypto.randomUUID() },
        { phase_id: phaseId, agent: 'planner', model: 'm' },
      ),
      event(
        runId,
        'message',
        {},
        {
          phase_id: phaseId,
          agent: 'planner',
          model: 'm',
          usage: { input: 10, output: 20, cache_read: 30, cache_write: 40 },
        },
      ),
      event(
        runId,
        'phase_end',
        { status: 'succeeded', summary_md: 'Planned', reported_cost: { m: 0.01 } },
        { phase_id: phaseId },
      ),
    ])
    const phase = await getTestDb()
      .selectFrom('phases')
      .selectAll()
      .where('id', '=', phaseId)
      .executeTakeFirstOrThrow()
    expect(phase).toMatchObject({
      name: 'plan',
      attempt: 1,
      status: 'succeeded',
      summary_md: 'Planned',
      reported_cost: { m: 0.01 },
    })
    const run = await getTestDb()
      .selectFrom('runs')
      .select('current_phase')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run.current_phase).toBe('plan')
  })

  // Ajv's default type coercion turned a null in a `string | null` field into "" and a null
  // duration into 0; found by the first smoke run, 2026-10-18.
  it('stores the fields an event leaves null as null', async () => {
    const { runId, token } = await claimed()
    const sent = event(runId, 'tool_call', {}, { agent: 'runner', tool: 'test_command' })
    expect((await send(token, [sent])).json()).toEqual({ accepted: 1 })
    const row = await getTestDb()
      .selectFrom('events')
      .select(['model', 'target', 'status', 'duration_ms', 'phase_id'])
      .where('id', '=', sent.id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({
      model: null,
      target: null,
      status: null,
      duration_ms: null,
      phase_id: null,
    })
  })

  // Review Focus 3: a replay after the server was down counts each event once.
  it('ignores a replayed event', async () => {
    const { runId, token } = await claimed()
    const same = event(
      runId,
      'message',
      {},
      { model: 'm', usage: { input: 5, output: 0, cache_read: 0, cache_write: 0 } },
    )
    expect((await send(token, [same])).json()).toEqual({ accepted: 1 })
    expect((await send(token, [same])).json()).toEqual({ accepted: 0 })
    const rows = await getTestDb()
      .selectFrom('events')
      .select('input')
      .where('run_id', '=', runId)
      .execute()
    expect(rows).toEqual([{ input: 5 }])
  })

  it('moves the card to Review and records the pull request', async () => {
    const { runId, taskId, token } = await claimed()
    const announced = app.bus.next('run.event', 5_000)
    await send(token, [
      event(runId, 'run_end', {
        outcome: 'review',
        pr_number: 7,
        pr_url: 'https://github.com/owner/pay/pull/7',
        branch: 'board/PAY-1-r1',
      }),
    ])
    expect(await state(taskId)).toBe('review')
    const run = await getTestDb()
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run).toMatchObject({ status: 'succeeded', pr_number: 7, branch: 'board/PAY-1-r1' })
    const artifact = await getTestDb()
      .selectFrom('artifacts')
      .selectAll()
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(artifact).toMatchObject({ kind: 'pr', uri: 'https://github.com/owner/pay/pull/7' })
    expect(await announced).toEqual({ topic: 'run.event', runId, taskId })
  })

  it('moves the card to Failed with the reason', async () => {
    const { runId, taskId, token } = await claimed()
    await send(token, [
      event(runId, 'run_end', { outcome: 'failed', reason: 'verify failed three times' }),
    ])
    expect(await state(taskId)).toBe('failed')
    const run = await getTestDb()
      .selectFrom('runs')
      .select(['status', 'failure_reason'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run).toEqual({ status: 'failed', failure_reason: 'verify failed three times' })
  })

  it('accepts a failure report for a card the owner already cancelled', async () => {
    const { runId, taskId, token } = await claimed()
    await getTestDb()
      .updateTable('tasks')
      .set({ state: 'failed' })
      .where('id', '=', taskId)
      .execute()
    const response = await send(token, [
      event(runId, 'run_end', { outcome: 'cancelled', reason: 'cancelled by the owner' }),
    ])
    expect(response.statusCode).toBe(200)
    expect(await state(taskId)).toBe('failed')
  })

  it('refuses a malformed phase event without storing any of the batch', async () => {
    const { runId, token } = await claimed()
    const response = await send(token, [
      event(runId, 'message', {}),
      event(
        runId,
        'phase_start',
        { name: 'deploy', attempt: 1 },
        { phase_id: crypto.randomUUID(), agent: 'a', model: 'm' },
      ),
    ])
    expect(response.statusCode).toBe(400)
    const rows = await getTestDb()
      .selectFrom('events')
      .select('id')
      .where('run_id', '=', runId)
      .execute()
    expect(rows).toEqual([])
  })
})

describe('POST /api/runner/heartbeat', () => {
  it('records liveness and hands back the runs the owner cancelled', async () => {
    const { runId } = await claimed()
    await getTestDb()
      .updateTable('runs')
      .set({ cancel_requested: true })
      .where('id', '=', runId)
      .execute()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runner/heartbeat',
      headers: auth,
      payload: { runner_id: 'r1', run_ids: [runId] },
    })
    expect(response.json()).toEqual({ cancel: [runId] })
    const run = await getTestDb()
      .selectFrom('runs')
      .select('last_heartbeat_at')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run.last_heartbeat_at).toEqual(now)
  })
})
