import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GOOD_SPEC, seedProject, seedTask } from './fixtures.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import type { TaskState } from '../../src/shared/vocabulary.js'

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

async function card(state: TaskState, versions = 3): Promise<string> {
  const project = await seedProject(db())
  const task = await seedTask(db(), project.id, { state })
  for (let version = 1; version <= versions; version++)
    await db()
      .insertInto('specs')
      .values({
        task_id: task.id,
        version,
        body_md: GOOD_SPEC,
        status: version === versions ? 'draft' : 'superseded',
        criteria: null,
        approved_at: null,
      })
      .execute()
  return task.id
}

const ask = (taskId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/tasks/${taskId}/helps`, payload })
const helpRuns = (taskId: string) =>
  db()
    .selectFrom('runs')
    .selectAll()
    .where('task_id', '=', taskId)
    .where('kind', '=', 'help')
    .execute()
const helpRows = (taskId: string) =>
  db()
    .selectFrom('helps')
    .innerJoin('runs', 'runs.id', 'helps.run_id')
    .selectAll('helps')
    .where('runs.task_id', '=', taskId)
    .execute()
const REVIEW = { decision: 'spec_review', mode: 'review' }

describe('POST /api/tasks/:id/helps', () => {
  it('queues a help run and a help with the subject (AC5)', async () => {
    const taskId = await card('spec_review')
    const response = await ask(taskId, REVIEW)
    expect(response.statusCode).toBe(201)
    const runs = await helpRuns(taskId)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ number: 1, status: 'queued', queued_at: null })
    const [help] = await helpRows(taskId)
    expect(help).toMatchObject({
      status: 'queued',
      decision: 'spec_review',
      subject: { spec_version: 3 },
    })
    expect(response.json()).toMatchObject({ id: help!.id, decision: 'spec_review' })
  })

  it('answers with the help already in flight (AC6, AC37)', async () => {
    const taskId = await card('spec_review')
    const [first, second] = await Promise.all([ask(taskId, REVIEW), ask(taskId, REVIEW)])
    expect(second.json().id).toBe(first.json().id)
    expect(await helpRuns(taskId)).toHaveLength(1)
  })

  const refused: {
    name: string
    state: TaskState
    body: Record<string, unknown>
    status: number
    field?: string
    reason?: string
  }[] = [
    {
      name: 'a decision not offered',
      state: 'running',
      body: { decision: 'mark_done', mode: 'check' },
      status: 409,
      reason: 'not_offered',
    },
    {
      name: 'a mode of another decision',
      state: 'spec_review',
      body: { decision: 'spec_review', mode: 'recommend' },
      status: 400,
      field: 'mode',
    },
    {
      name: 'the question decision',
      state: 'spec_review',
      body: { decision: 'question', mode: 'suggest' },
      status: 400,
      field: 'decision',
    },
    {
      name: 'an unknown decision',
      state: 'spec_review',
      body: { decision: 'nope', mode: 'review' },
      status: 400,
      field: 'decision',
    },
    { name: 'an unknown field', state: 'spec_review', body: { ...REVIEW, extra: 1 }, status: 400 },
  ]
  it.each(refused)('refuses $name (AC7)', async ({ state, body, status, field, reason }) => {
    const taskId = await card(state)
    const response = await ask(taskId, body)
    expect(response.statusCode).toBe(status)
    const text = JSON.stringify(response.json())
    if (field !== undefined) expect(text).toContain(field)
    if (reason !== undefined) expect(response.json().details.reason).toBe(reason)
    expect(await helpRuns(taskId)).toHaveLength(0)
  })
})

describe('settling helps', () => {
  it('stops a queued review and cancels its run when a version is saved (AC22)', async () => {
    const taskId = await card('spec_review')
    await ask(taskId, REVIEW)
    const saved = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/specs`,
      payload: { body_md: GOOD_SPEC + '\nmore' },
    })
    expect(saved.statusCode).toBeLessThan(300)
    const [help] = await helpRows(taskId)
    expect(help!.status).toBe('stopped')
    expect((await helpRuns(taskId))[0]!.status).toBe('cancelled')
  })

  it('leaves no live review when Approve races a request (AC37)', async () => {
    const taskId = await card('spec_review')
    const spec = await db()
      .selectFrom('specs')
      .select('id')
      .where('task_id', '=', taskId)
      .where('version', '=', 3)
      .executeTakeFirstOrThrow()
    const [post] = await Promise.all([
      ask(taskId, REVIEW),
      app.inject({ method: 'POST', url: `/api/specs/${spec.id}/approve` }),
    ])
    expect([201, 409]).toContain(post.statusCode)
    const live = (await helpRows(taskId)).filter((help) =>
      ['queued', 'running'].includes(help.status),
    )
    expect(live).toHaveLength(0)
  })

  it('retires a succeeded help when its subject stops standing, and does not list it (AC24)', async () => {
    const taskId = await card('spec_review')
    const created = (await ask(taskId, REVIEW)).json()
    await db()
      .updateTable('helps')
      .set({ status: 'succeeded' })
      .where('id', '=', created.id)
      .execute()
    expect((await app.inject({ url: `/api/tasks/${taskId}/helps` })).json()).toHaveLength(1)
    await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/specs`,
      payload: { body_md: GOOD_SPEC + '\nx' },
    })
    expect((await app.inject({ url: `/api/tasks/${taskId}/helps` })).json()).toHaveLength(0)
    const row = (await helpRows(taskId))[0]!
    expect(row.retired_at).not.toBeNull()
  })

  it('lists only the latest review when an older one succeeded for a stale version (AC25)', async () => {
    const taskId = await card('spec_review', 2)
    const old = (await ask(taskId, REVIEW)).json()
    await db().updateTable('helps').set({ status: 'succeeded' }).where('id', '=', old.id).execute()
    await db().updateTable('runs').set({ status: 'succeeded' }).where('kind', '=', 'help').execute()
    await db().updateTable('helps').set({ retired_at: null }).execute()
    await db()
      .insertInto('specs')
      .values({
        task_id: taskId,
        version: 3,
        body_md: 'x',
        status: 'draft',
        criteria: null,
        approved_at: null,
      })
      .execute()
    const run = await db()
      .insertInto('runs')
      .values({ task_id: taskId, kind: 'help', number: 2, status: 'failed', queued_at: null })
      .returning('id')
      .executeTakeFirstOrThrow()
    const failed = await db()
      .insertInto('helps')
      .values({
        run_id: run.id,
        approval_id: null,
        decision: 'spec_review',
        subject: JSON.stringify({ spec_version: 3 }),
        question_index: null,
        mode: 'review',
        status: 'failed',
        result: null,
        reason: 'x',
        phase_id: null,
        runner_id: null,
        started_at: null,
        ended_at: null,
        last_heartbeat_at: null,
        created_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const listed = (await app.inject({ url: `/api/tasks/${taskId}/helps` })).json()
    expect(listed.map((help: { id: string }) => help.id)).toEqual([failed.id])
  })
})
