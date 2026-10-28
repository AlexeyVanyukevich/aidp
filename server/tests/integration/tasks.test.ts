import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { GOOD_SPEC, seedProject, seedTask } from './fixtures.js'
import { moveTask } from '../../src/modules/tasks/task.moves.js'

let app: FastifyInstance
let projectId: string

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(async () => {
  await resetDb()
  projectId = (await seedProject(getTestDb())).id
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('POST /api/projects/:key/tasks', () => {
  it('creates a task in Backlog with the next number', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/projects/PAY/tasks',
      payload: { title: 'One' },
    })
    const second = await app.inject({
      method: 'POST',
      url: '/api/projects/PAY/tasks',
      payload: { title: 'Two', description_md: 'Why', budget_usd: 3 },
    })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({ key: 'PAY-1', state: 'backlog', budget_usd: null })
    expect(second.json()).toMatchObject({ key: 'PAY-2', description_md: 'Why', budget_usd: 3 })
  })

  it.each([
    ['a blank title', { title: '  ' }],
    ['a negative budget', { title: 'T', budget_usd: -1 }],
    ['a state', { title: 'T', state: 'done' }],
  ])('refuses %s', async (_name, payload) => {
    const response = await app.inject({ method: 'POST', url: '/api/projects/PAY/tasks', payload })
    expect(response.statusCode).toBe(400)
  })

  it('answers 404 for a project that does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/NOPE/tasks',
      payload: { title: 'T' },
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('GET /api/projects/:key/tasks', () => {
  it('lists the board, each column in its order', async () => {
    await seedTask(getTestDb(), projectId, { number: 1, title: 'B', position: 2 })
    await seedTask(getTestDb(), projectId, { number: 2, title: 'A', position: 1 })
    await seedTask(getTestDb(), projectId, { number: 3, title: 'R', state: 'review', position: 1 })
    const response = await app.inject({ method: 'GET', url: '/api/projects/PAY/tasks' })
    expect(response.json().tasks.map((t: { title: string }) => t.title)).toEqual(['A', 'B', 'R'])
  })
})

describe('PATCH /api/tasks/:id', () => {
  it('edits the title and the description', async () => {
    const { id } = await seedTask(getTestDb(), projectId)
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${id}`,
      payload: { title: 'Renamed', description_md: 'More' },
    })
    expect(response.json()).toMatchObject({ title: 'Renamed', description_md: 'More' })
  })

  it('reorders a card within its column', async () => {
    const { id } = await seedTask(getTestDb(), projectId)
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${id}`,
      payload: { position: 0.5 },
    })
    expect(response.json().position).toBe(0.5)
  })

  it('moves a card from Review to Done when dragged', async () => {
    const { id } = await seedTask(getTestDb(), projectId, { state: 'review' })
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${id}`,
      payload: { state: 'done' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().state).toBe('done')
  })

  // Review Focus 4: a drop on a card the runner moved since the board was drawn.
  it('answers 409 for a drag from any column but Review', async () => {
    const { id } = await seedTask(getTestDb(), projectId, { state: 'running' })
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${id}`,
      payload: { state: 'done' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      error: 'conflict',
      details: { state: 'running', move: 'mark_done' },
    })
  })

  it.each(['backlog', 'spec_review', 'failed'] as const)(
    'marks a %s card done, last in Done',
    async (state) => {
      await seedTask(getTestDb(), projectId, { number: 8, state: 'done', position: 7 })
      const { id } = await seedTask(getTestDb(), projectId, { number: 9, state })
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${id}`,
        payload: { state: 'done' },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().state).toBe('done')
      expect(response.json().position).toBeGreaterThan(7)
    },
  )

  it.each(['backlog', 'spec_review', 'failed'] as const)(
    'keeps the specs, runs and artifacts of a %s card when it is marked done',
    async (state) => {
      const db = getTestDb()
      const { id } = await seedTask(db, projectId, { number: 9, state })
      if (state !== 'backlog') {
        await db
          .insertInto('specs')
          .values({ task_id: id, version: 1, body_md: GOOD_SPEC, status: 'draft', criteria: null })
          .execute()
        const run = await db
          .insertInto('runs')
          .values({
            task_id: id,
            kind: state === 'failed' ? 'delivery' : 'spec',
            number: 1,
            spec_version: state === 'failed' ? 1 : null,
            status: 'failed',
            failure_reason: state === 'failed' ? 'pull request closed without merging' : null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        await db
          .insertInto('artifacts')
          .values({ run_id: run.id, kind: 'verify_report', body_md: 'x', uri: null, data: null })
          .execute()
      }
      const count = async (table: 'specs' | 'runs' | 'artifacts') =>
        Number(
          (
            await db
              .selectFrom(table)
              .select((eb) => eb.fn.countAll().as('n'))
              .executeTakeFirstOrThrow()
          ).n,
        )
      const before = [await count('specs'), await count('runs'), await count('artifacts')]
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${id}`,
        payload: { state: 'done' },
      })
      expect(response.statusCode).toBe(200)
      expect([await count('specs'), await count('runs'), await count('artifacts')]).toEqual(before)
    },
  )

  it.each(['spec_draft', 'ready', 'needs_approval', 'blocked', 'done'] as const)(
    'answers 409 for a %s card',
    async (state) => {
      const { id } = await seedTask(getTestDb(), projectId, { state })
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${id}`,
        payload: { state: 'done' },
      })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({
        error: 'conflict',
        details: { state, move: 'mark_done' },
      })
    },
  )

  it.each([
    ['any other state', { state: 'ready' }],
    ['nothing at all', {}],
  ])('refuses %s', async (_name, payload) => {
    const { id } = await seedTask(getTestDb(), projectId)
    const response = await app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload })
    expect(response.statusCode).toBe(400)
  })
})

describe('moveTask', () => {
  it('announces the move', async () => {
    const { id } = await seedTask(getTestDb(), projectId, { state: 'review' })
    const announced = app.bus.next('task.updated', 5_000)
    await moveTask(getTestDb(), id, 'merge')
    expect(await announced).toEqual({ topic: 'task.updated', taskId: id })
  })

  it('places a moved card last in its new column', async () => {
    await seedTask(getTestDb(), projectId, { number: 1, state: 'done', position: 7 })
    const { id } = await seedTask(getTestDb(), projectId, { number: 2, state: 'review' })
    await moveTask(getTestDb(), id, 'merge')
    const row = await getTestDb()
      .selectFrom('tasks')
      .select('position')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(row.position).toBe(8)
  })
})

// Slice 3 spec §8: a draft reads the description it started with.
describe('the description', () => {
  it.each([
    ['backlog', 200],
    ['spec_review', 200],
    ['spec_draft', 409],
    ['ready', 409],
    ['running', 409],
  ] as const)('in %s answers %i', async (state, status) => {
    const { id } = await seedTask(getTestDb(), projectId, { state })
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${id}`,
      payload: { description_md: 'Retry failed webhooks.' },
    })
    expect(response.statusCode).toBe(status)
  })
})
