import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { GOOD_SPEC, seedProject, seedTask } from './fixtures.js'

let app: FastifyInstance
let taskId: string

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(async () => {
  await resetDb()
  const project = await seedProject(getTestDb())
  taskId = (await seedTask(getTestDb(), project.id)).id
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const save = (body_md: string) =>
  app.inject({ method: 'POST', url: `/api/tasks/${taskId}/specs`, payload: { body_md } })
const approve = (specId: string) =>
  app.inject({ method: 'POST', url: `/api/specs/${specId}/approve` })
const taskState = async () =>
  (
    await getTestDb()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
  ).state

describe('saving a spec', () => {
  it('stores version 1, lints it, and moves the card to Spec review', async () => {
    const response = await save(GOOD_SPEC)
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      version: 1,
      status: 'draft',
      lint: { requirements: ['R1'], open_questions: [], findings: [], approvable: true },
    })
    expect(await taskState()).toBe('spec_review')
  })

  it('makes each save a new version and supersedes the drafts before it', async () => {
    await save(GOOD_SPEC)
    const second = await save(`${GOOD_SPEC}- Is one second right?\n`)
    expect(second.json()).toMatchObject({ version: 2, lint: { approvable: false } })
    const list = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/specs` })
    expect(
      list.json().map((s: { version: number; status: string }) => [s.version, s.status]),
    ).toEqual([
      [2, 'draft'],
      [1, 'superseded'],
    ])
  })
})

describe('approving a spec', () => {
  it('freezes the version, moves the card to Ready and queues a delivery run', async () => {
    const spec = (await save(GOOD_SPEC)).json()
    const queued = app.bus.next('run.queued', 5_000)
    const response = await approve(spec.id)

    expect(response.statusCode).toBe(200)
    expect(response.json().spec).toMatchObject({
      status: 'approved',
      approved_at: expect.any(String),
    })
    expect(await taskState()).toBe('ready')
    const run = await getTestDb()
      .selectFrom('runs')
      .selectAll()
      .where('task_id', '=', taskId)
      .executeTakeFirstOrThrow()
    expect(run).toMatchObject({
      id: response.json().run_id,
      kind: 'delivery',
      spec_version: 1,
      status: 'queued',
    })
    expect(await queued).toEqual({ topic: 'run.queued', runId: run.id })
    const stored = await getTestDb()
      .selectFrom('specs')
      .select('criteria')
      .where('id', '=', spec.id)
      .executeTakeFirstOrThrow()
    expect(stored.criteria).toEqual([
      { id: 'AC1', requirements: ['R1'], text: 'Given a failure Then it retries after 1s' },
    ])
  })

  it('refuses a spec whose lint fails, listing the findings', async () => {
    const spec = (await save(GOOD_SPEC.replace(/- AC1.*\n/, ''))).json()
    const response = await approve(spec.id)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: 'validation_error',
      details: { findings: [{ code: 'requirement_without_criterion', id: 'R1' }] },
    })
    expect(await taskState()).toBe('spec_review')
  })

  it('refuses a spec with an open question', async () => {
    const spec = (await save(`${GOOD_SPEC}- Is one second right?\n`)).json()
    const response = await approve(spec.id)
    expect(response.statusCode).toBe(400)
    expect(response.json().details.open_questions).toEqual(['Is one second right?'])
  })

  // Review Focus 4: two tabs, one stale.
  it.each([
    [
      'a version already approved',
      async (first: string) => {
        await approve(first)
        return first
      },
    ],
    [
      'a version another save superseded',
      async (first: string) => {
        await save(GOOD_SPEC)
        return first
      },
    ],
  ])('answers 409 for %s', async (_name, arrange) => {
    const first = (await save(GOOD_SPEC)).json().id
    const target = await arrange(first)
    const response = await approve(target)
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('conflict')
  })

  it('refuses a new version once the spec is approved', async () => {
    const spec = (await save(GOOD_SPEC)).json()
    await approve(spec.id)
    const response = await save(GOOD_SPEC)
    expect(response.statusCode).toBe(409)
  })
})
