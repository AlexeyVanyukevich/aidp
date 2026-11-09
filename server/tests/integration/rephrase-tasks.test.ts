import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'
import { GOOD_SPEC, seedProject, seedQueuedRun, seedTask } from './fixtures.js'
import type { RunStatus, SuggestionStatus, TaskState } from '../../src/shared/vocabulary.js'

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
const auth = { authorization: `Bearer ${TEST_RUNNER_KEY}` }
const post = (url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as never })
const act = (taskId: string, action: string) => post(`/api/tasks/${taskId}/actions/${action}`)
const card = async (taskId: string) =>
  (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json()

async function seed(
  state: TaskState = 'backlog',
  description = 'Retry failed webhooks.',
): Promise<string> {
  const { id: projectId } = await seedProject(db())
  const { id } = await seedTask(db(), projectId, { state })
  await db()
    .updateTable('tasks')
    .set({ description_md: description })
    .where('id', '=', id)
    .execute()
  return id
}

interface SeededRephrase {
  status?: RunStatus
  number?: number
  base_md?: string
  suggestion_md?: string | null
  suggestion_status?: SuggestionStatus | null
  failure_reason?: string | null
}
async function seedRephrase(taskId: string, run: SeededRephrase = {}): Promise<string> {
  const row = await db()
    .insertInto('runs')
    .values({
      task_id: taskId,
      kind: 'rephrase',
      number: run.number ?? 1,
      status: run.status ?? 'succeeded',
      base_md: run.base_md ?? 'Retry failed webhooks.',
      suggestion_md: run.suggestion_md ?? null,
      suggestion_status: run.suggestion_status ?? null,
      failure_reason: run.failure_reason ?? null,
      ...(run.status === 'queued' ? { queued_at: new Date() } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}
const runsOf = (taskId: string) =>
  db()
    .selectFrom('runs')
    .selectAll()
    .where('task_id', '=', taskId)
    .where('kind', '=', 'rephrase')
    .orderBy('number')
    .execute()
const stateOf = async (taskId: string) =>
  (
    await db()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
  ).state

describe('actions/rephrase', () => {
  it.each(['backlog', 'spec_review'] as const)(
    'queues a rephrase run in %s, replaces the pending suggestion, and leaves the card',
    async (state) => {
      const id = await seed(state)
      await seedRephrase(id, { suggestion_md: 'old', suggestion_status: 'pending' })
      const response = await act(id, 'rephrase')
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ state, rephrase: { status: 'queued' } })
      const [first, second] = await runsOf(id)
      expect(first).toMatchObject({ suggestion_status: 'replaced' })
      expect(first!.suggestion_decided_at).not.toBeNull()
      expect(second).toMatchObject({
        number: 2,
        status: 'queued',
        base_md: 'Retry failed webhooks.',
      })
      expect(await stateOf(id)).toBe(state)
    },
  )

  it('refuses a blank description with the field named, and queues nothing', async () => {
    const id = await seed('backlog', '   ')
    const response = await act(id, 'rephrase')
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: 'validation_error',
      details: { field: 'description_md' },
    })
    expect(await runsOf(id)).toEqual([])
  })

  it('answers 409 in Ready, and while a rephrase is queued or running', async () => {
    const { taskId } = await seedQueuedRun(db())
    expect((await act(taskId, 'rephrase')).statusCode).toBe(409)
    expect(await runsOf(taskId)).toEqual([])
    await resetDb()
    for (const status of ['queued', 'running'] as const) {
      const id = await seed()
      await seedRephrase(id, { status })
      expect((await act(id, 'rephrase')).statusCode).toBe(409)
      expect(await runsOf(id)).toHaveLength(1)
      await resetDb()
    }
  })
})

describe('actions/cancel-rephrase', () => {
  it('ends a queued run at once', async () => {
    const id = await seed()
    await seedRephrase(id, { status: 'queued' })
    expect((await act(id, 'cancel-rephrase')).statusCode).toBe(200)
    expect(await runsOf(id)).toMatchObject([{ status: 'cancelled', queued_at: null }])
    expect(await stateOf(id)).toBe('backlog')
  })

  it('asks the runner to stop a running one', async () => {
    const id = await seed()
    const runId = await seedRephrase(id, { status: 'running' })
    expect((await act(id, 'cancel-rephrase')).statusCode).toBe(200)
    expect(await runsOf(id)).toMatchObject([{ status: 'running', cancel_requested: true }])
    const beat = await app.inject({
      method: 'POST',
      url: '/api/runner/heartbeat',
      headers: auth,
      payload: { runner_id: 'r1', run_ids: [runId] },
    })
    expect(beat.statusCode).toBe(200)
    expect(await stateOf(id)).toBe('backlog')
  })

  it('answers 409 with none in flight', async () => {
    const id = await seed()
    await seedRephrase(id)
    expect((await act(id, 'cancel-rephrase')).statusCode).toBe(409)
  })
})

describe('while a rephrase is in flight', () => {
  const reason = { error: 'conflict', details: { reason: 'rephrasing' } }

  it('refuses Draft spec', async () => {
    const id = await seed()
    await seedRephrase(id, { status: 'queued' })
    const response = await act(id, 'draft-spec')
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject(reason)
    expect(await stateOf(id)).toBe('backlog')
  })

  it('refuses Redraft and Approve, and allows saving the description and a spec by hand', async () => {
    const id = await seed('spec_review')
    const spec = await db()
      .insertInto('specs')
      .values({ task_id: id, version: 1, body_md: GOOD_SPEC, status: 'draft', criteria: null })
      .returning('id')
      .executeTakeFirstOrThrow()
    await seedRephrase(id, { status: 'running' })
    const redraft = await post(`/api/tasks/${id}/actions/redraft`, { note: 'shorter' })
    expect(redraft.statusCode).toBe(409)
    expect(redraft.json()).toMatchObject(reason)
    const approve = await post(`/api/specs/${spec.id}/approve`)
    expect(approve.statusCode).toBe(409)
    expect(approve.json()).toMatchObject(reason)
    expect(await stateOf(id)).toBe('spec_review')
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${id}`,
      payload: { description_md: 'New text.' },
    })
    expect(patch.statusCode).toBe(200)
    expect((await post(`/api/tasks/${id}/specs`, { body_md: GOOD_SPEC })).statusCode).toBe(201)
  })
})

describe('suggestion/accept and suggestion/discard', () => {
  const pending = (id: string) =>
    seedRephrase(id, { suggestion_md: 'Clearer text.', suggestion_status: 'pending' })

  it('accept sets the description to the edited text and decides the suggestion', async () => {
    const id = await seed()
    await pending(id)
    const response = await post(`/api/tasks/${id}/suggestion/accept`, {
      description_md: 'Clearer text, edited.',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      description_md: 'Clearer text, edited.',
      rephrase: { suggestion: null },
    })
    const [run] = await runsOf(id)
    expect(run).toMatchObject({ suggestion_status: 'accepted' })
    expect(run!.suggestion_decided_at).not.toBeNull()
  })

  it('discard leaves the description and decides the suggestion', async () => {
    const id = await seed()
    await pending(id)
    const response = await post(`/api/tasks/${id}/suggestion/discard`)
    expect(response.json()).toMatchObject({ description_md: 'Retry failed webhooks.' })
    expect(await runsOf(id)).toMatchObject([{ suggestion_status: 'discarded' }])
  })

  it('answers 409 with no pending suggestion, or in Ready, and changes nothing', async () => {
    const id = await seed()
    await seedRephrase(id, { suggestion_md: 'x', suggestion_status: 'discarded' })
    expect((await post(`/api/tasks/${id}/suggestion/discard`)).statusCode).toBe(409)
    expect(
      (await post(`/api/tasks/${id}/suggestion/accept`, { description_md: 'y' })).statusCode,
    ).toBe(409)
    const { taskId } = await seedQueuedRun(db(), { projectKey: 'OTH' })
    await pending(taskId)
    expect((await post(`/api/tasks/${taskId}/suggestion/discard`)).statusCode).toBe(409)
    expect(
      (await post(`/api/tasks/${taskId}/suggestion/accept`, { description_md: 'y' })).statusCode,
    ).toBe(409)
    expect(await runsOf(taskId)).toMatchObject([{ suggestion_status: 'pending' }])
  })

  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['line breaks', '\n\t\n'],
  ])('refuses a blank accepted text: %s', async (_name, description_md) => {
    const id = await seed()
    await pending(id)
    expect((await post(`/api/tasks/${id}/suggestion/accept`, { description_md })).statusCode).toBe(
      400,
    )
    expect(await runsOf(id)).toMatchObject([{ suggestion_status: 'pending' }])
  })
})

describe('the card view', () => {
  it('has no rephrase block before any run', async () => {
    expect((await card(await seed())).rephrase).toBeNull()
  })

  it('marks a pending suggestion stale once the description differs from its base', async () => {
    const id = await seed()
    await seedRephrase(id, { suggestion_md: 'S', suggestion_status: 'pending' })
    expect((await card(id)).rephrase).toEqual({
      status: 'succeeded',
      failure_reason: null,
      suggestion: { body_md: 'S', stale: false },
    })
    await db().updateTable('tasks').set({ description_md: 'Edited' }).where('id', '=', id).execute()
    expect((await card(id)).rephrase.suggestion.stale).toBe(true)
    await db()
      .updateTable('tasks')
      .set({ description_md: 'Retry failed webhooks.' })
      .where('id', '=', id)
      .execute()
    expect((await card(id)).rephrase.suggestion.stale).toBe(false)
  })

  it('holds the failure reason of a failed run, and none for a cancelled one', async () => {
    const id = await seed()
    await seedRephrase(id, {
      status: 'failed',
      failure_reason: 'the rephraser saved no suggestion',
    })
    expect((await card(id)).rephrase).toMatchObject({
      status: 'failed',
      failure_reason: 'the rephraser saved no suggestion',
    })
    await seedRephrase(id, { number: 2, status: 'cancelled', failure_reason: 'cancelled' })
    expect((await card(id)).rephrase).toMatchObject({ status: 'cancelled', failure_reason: null })
  })
})

describe('a rephrase run beside the other runs', () => {
  it('is not the latest run for the moves, the draft failure or the board', async () => {
    const id = await seed('spec_review')
    await db()
      .insertInto('runs')
      .values({ task_id: id, kind: 'spec', number: 1, status: 'failed', failure_reason: 'boom' })
      .execute()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await seedRephrase(id, { suggestion_md: 'S', suggestion_status: 'pending' })
    const view = await card(id)
    expect(view.draft_failure).toBe('boom')
    const board = await app.inject({ method: 'GET', url: '/api/projects/PAY/tasks' })
    expect(board.json().tasks[0]).toMatchObject({ phase: null })
    await db()
      .updateTable('runs')
      .set({ current_phase: 'rephrase' })
      .where('kind', '=', 'rephrase')
      .execute()
    expect(
      (await app.inject({ method: 'GET', url: '/api/projects/PAY/tasks' })).json().tasks[0],
    ).toMatchObject({ phase: null })
  })
})

describe('claiming a rephrase run', () => {
  const claim = () =>
    app.inject({
      method: 'POST',
      url: '/api/runner/claim',
      headers: auth,
      payload: { runner_id: 'r1', wait_ms: 0, kinds: ['title', 'rephrase'] },
    })

  it('starts it without moving the card, and hands over the base text and the budget', async () => {
    const id = await seed('spec_review')
    await db().updateTable('tasks').set({ budget_usd: 2.5 }).where('id', '=', id).execute()
    const runId = await seedRephrase(id, { status: 'queued', base_md: 'The base.' })
    const work = (await claim()).json().work
    expect(work).toMatchObject({
      kind: 'start',
      run: { id: runId, kind: 'rephrase', base_md: 'The base.', task: { budget_usd: 2.5 } },
    })
    expect(await stateOf(id)).toBe('spec_review')
  })

  it('cancels a queued run whose card left Backlog and Spec review', async () => {
    const id = await seed('ready')
    const runId = await seedRephrase(id, { status: 'queued' })
    expect((await claim()).json().work).toBeNull()
    const row = await db()
      .selectFrom('runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('cancelled')
  })

  it('is left queued for a claim that names no kinds', async () => {
    const id = await seed()
    await seedRephrase(id, { status: 'queued' })
    const response = await app.inject({
      method: 'POST',
      url: '/api/runner/claim',
      headers: auth,
      payload: { runner_id: 'r1', wait_ms: 0 },
    })
    expect(response.json().work).toBeNull()
  })
})
