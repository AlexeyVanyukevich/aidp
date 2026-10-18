import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedProject, seedTask } from './fixtures.js'
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
      details: { state: 'running', move: 'drag_done' },
    })
  })

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
