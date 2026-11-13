import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { GOOD_SPEC, seedProject, seedTask, seedTitleRun } from './fixtures.js'
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

  it('changes the title in Spec review and refuses it in Running', async () => {
    const review = await seedTask(getTestDb(), projectId, { number: 5, state: 'spec_review' })
    const running = await seedTask(getTestDb(), projectId, { number: 6, state: 'running' })
    const patch = (id: string) =>
      app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { title: 'Changed' } })
    expect((await patch(review.id)).json().title).toBe('Changed')
    const refused = await patch(running.id)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toBe('conflict')
    const row = await getTestDb()
      .selectFrom('tasks')
      .select('title')
      .where('id', '=', running.id)
      .executeTakeFirstOrThrow()
    expect(row.title).toBe('Retry webhooks')
  })

  it('keeps a failed draft’s reason when a title run follows it', async () => {
    const { id } = await seedTask(getTestDb(), projectId, { number: 7, state: 'spec_review' })
    await getTestDb()
      .insertInto('runs')
      .values({
        task_id: id,
        kind: 'spec',
        number: 1,
        status: 'failed',
        failure_reason: 'the draft failed',
      })
      .execute()
    await seedTitleRun(getTestDb(), id, { status: 'succeeded', failure_reason: 'unrelated' })
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${id}` })
    expect(response.json().draft_failure).toBe('the draft failed')
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

describe('PATCH state done under a concurrent move', () => {
  type Row = {
    name: string
    from: 'review' | 'backlog'
    meanwhile: 'close_pr' | 'draft_spec'
    ends: string
  }
  const rows: Row[] = [
    {
      name: 'a card in Review closed meanwhile',
      from: 'review',
      meanwhile: 'close_pr',
      ends: 'failed',
    },
    {
      name: 'a card in Backlog drafted meanwhile',
      from: 'backlog',
      meanwhile: 'draft_spec',
      ends: 'spec_draft',
    },
  ]
  it.each(rows)('waits for the lock, then answers 409: $name', async (row) => {
    const { id } = await seedTask(getTestDb(), projectId, { state: row.from })
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const holder = getTestDb()
      .transaction()
      .execute(async (trx) => {
        await moveTask(trx, id, row.meanwhile)
        locked()
        await held
      })
    await isLocked
    let settled = false
    const request = app
      .inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { state: 'done' } })
      .then((response) => {
        settled = true
        return response
      })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(settled).toBe(false)
    release()
    await holder
    const response = await request
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'conflict' })
    const after = await getTestDb()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(after.state).toBe(row.ends)
  })
})

describe('moveTask', () => {
  it('announces the move', async () => {
    const { id } = await seedTask(getTestDb(), projectId, { state: 'review' })
    const announced = app.bus.next('task.updated', 5_000)
    await getTestDb()
      .transaction()
      .execute((trx) => moveTask(trx, id, 'merge'))
    expect(await announced).toEqual({ topic: 'task.updated', taskId: id })
  })

  it('places a moved card last in its new column', async () => {
    await seedTask(getTestDb(), projectId, { number: 1, state: 'done', position: 7 })
    const { id } = await seedTask(getTestDb(), projectId, { number: 2, state: 'review' })
    await getTestDb()
      .transaction()
      .execute((trx) => moveTask(trx, id, 'merge'))
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

describe('the test command a task chose', () => {
  const addCommand = async (project: string, name: string, command: string) =>
    (
      await getTestDb()
        .insertInto('project_test_commands')
        .values({ project_id: project, name, command })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
  const patch = (id: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: payload as object })
  const get = async (id: string) =>
    (await app.inject({ method: 'GET', url: `/api/tasks/${id}` })).json()

  it('is set, cleared and survives a rename', async () => {
    const { id } = await seedTask(getTestDb(), projectId, { state: 'ready' })
    const unit = await addCommand(projectId, 'unit', 'npm run unit')
    expect((await patch(id, { test_command_id: unit })).statusCode).toBe(200)
    expect((await get(id)).test_command_id).toBe(unit)
    await getTestDb()
      .updateTable('project_test_commands')
      .set({ name: 'renamed' })
      .where('id', '=', unit)
      .execute()
    expect((await get(id)).test_command_id).toBe(unit)
    expect((await patch(id, { test_command_id: null })).statusCode).toBe(200)
    expect((await get(id)).test_command_id).toBeNull()
  })

  it('refuses a command of another project, naming the field', async () => {
    const { id } = await seedTask(getTestDb(), projectId, { state: 'ready' })
    const other = await seedProject(getTestDb(), { key: 'OTH' })
    const foreign = await addCommand(other.id, 'unit', 'x')
    const response = await patch(id, { test_command_id: foreign })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ details: { field: 'test_command_id' } })
  })

  it('is fixed once the task is Done', async () => {
    const { id } = await seedTask(getTestDb(), projectId, { state: 'done' })
    const unit = await addCommand(projectId, 'unit', 'x')
    const response = await patch(id, { test_command_id: unit })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('conflict')
    expect((await get(id)).test_command_id).toBeNull()
  })

  type Run = { status: 'failed' | 'queued' | 'cancelled'; started: boolean; command: string | null }
  const testedWith: [string, Run[], string | null][] = [
    ['no run', [], null],
    [
      'one started run',
      [{ status: 'failed', started: true, command: 'npm run unit' }],
      'npm run unit',
    ],
    ['a queued run never started', [{ status: 'queued', started: false, command: null }], null],
    [
      'a started run and a re-run cancelled unstarted',
      [
        { status: 'failed', started: true, command: 'npm run unit' },
        { status: 'cancelled', started: false, command: null },
      ],
      'npm run unit',
    ],
  ]
  it.each(testedWith)('reads tested_with for %s', async (_name, runs, expected) => {
    const { id } = await seedTask(getTestDb(), projectId, { state: 'failed' })
    await getTestDb()
      .insertInto('specs')
      .values({ task_id: id, version: 1, body_md: GOOD_SPEC, status: 'approved' })
      .execute()
    for (const [index, run] of runs.entries())
      await getTestDb()
        .insertInto('runs')
        .values({
          task_id: id,
          kind: 'delivery',
          number: index + 1,
          spec_version: 1,
          status: run.status,
          test_command: run.command,
          started_at: run.started ? new Date() : null,
          created_at: new Date(Date.now() + index * 1000),
        })
        .execute()
    expect((await get(id)).tested_with).toBe(expected)
  })
})

describe('POST /api/projects/:key/tasks/reorder', () => {
  const reorder = (key = 'PAY') =>
    app.inject({ method: 'POST', url: `/api/projects/${key}/tasks/reorder` })

  async function positions(): Promise<Record<string, number>> {
    const rows = await getTestDb().selectFrom('tasks').select(['title', 'position']).execute()
    return Object.fromEntries(rows.map((row) => [row.title, row.position]))
  }

  async function seedMessy(): Promise<void> {
    const db = getTestDb()
    await seedTask(db, projectId, { number: 1, title: 'b1', position: 0.5 })
    await seedTask(db, projectId, { number: 2, title: 'b2', position: 0.75 })
    await seedTask(db, projectId, { number: 3, title: 'b3', position: 3 })
    await seedTask(db, projectId, { number: 4, title: 'd1', state: 'done', position: 2 })
    await seedTask(db, projectId, { number: 5, title: 'd2', state: 'done', position: 7 })
    await seedTask(db, projectId, { number: 6, title: 'f1', state: 'failed', position: 1 })
    // b3 and f1 are already where they belong; pin their updated_at in the past.
    await db
      .updateTable('tasks')
      .set({ updated_at: new Date('2020-01-01T00:00:00Z') })
      .where('title', 'in', ['b3', 'f1'])
      .execute()
  }

  function collect(): { ids: string[]; stop: () => void } {
    const ids: string[] = []
    const stop = app.bus.subscribe((message) => {
      if (message.topic === 'task.updated') ids.push(message.taskId)
    })
    return { ids, stop }
  }

  it('renumbers every column, keeps states, and touches only the rows that change', async () => {
    await seedMessy()
    const spy = collect()
    const response = await reorder()
    await new Promise((resolve) => setTimeout(resolve, 300))
    spy.stop()
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ reordered: 4 })
    expect(await positions()).toEqual({ b1: 1, b2: 2, b3: 3, d1: 1, d2: 2, f1: 1 })
    const rows = await getTestDb()
      .selectFrom('tasks')
      .select(['id', 'title', 'state', 'updated_at'])
      .execute()
    const by = Object.fromEntries(rows.map((row) => [row.title, row]))
    expect(by.b1?.state).toBe('backlog')
    expect(by.d1?.state).toBe('done')
    expect(by.f1?.state).toBe('failed')
    expect(by.b3?.updated_at.toISOString()).toBe('2020-01-01T00:00:00.000Z')
    expect(by.f1?.updated_at.toISOString()).toBe('2020-01-01T00:00:00.000Z')
    expect(spy.ids.sort()).toEqual(['b1', 'b2', 'd1', 'd2'].map((t) => by[t]!.id).sort())
  })

  it('answers 0 and writes and publishes nothing when every column is in order', async () => {
    const db = getTestDb()
    await seedTask(db, projectId, { number: 1, title: 'a', position: 1 })
    await seedTask(db, projectId, { number: 2, title: 'b', position: 2 })
    await seedTask(db, projectId, { number: 3, title: 'c', state: 'done', position: 1 })
    await db
      .updateTable('tasks')
      .set({ updated_at: new Date('2020-01-01T00:00:00Z') })
      .execute()
    const spy = collect()
    const response = await reorder()
    await new Promise((resolve) => setTimeout(resolve, 300))
    spy.stop()
    expect(response.json()).toEqual({ reordered: 0 })
    expect(spy.ids).toEqual([])
    const rows = await db.selectFrom('tasks').select('updated_at').execute()
    expect(rows.every((row) => row.updated_at.toISOString() === '2020-01-01T00:00:00.000Z')).toBe(
      true,
    )
  })

  it('answers 404 for an unknown project', async () => {
    const response = await reorder('NOPE')
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('not_found')
  })

  const BODIES: [
    string,
    { payload?: string; headers?: Record<string, string> },
    number,
    string?,
  ][] = [
    ['no body and no content type', {}, 200],
    ['an empty object', { payload: '{}', headers: { 'content-type': 'application/json' } }, 200],
    [
      'a field',
      { payload: '{"x":1}', headers: { 'content-type': 'application/json' } },
      400,
      'validation_error',
    ],
    [
      'a JSON content type with an empty body',
      { payload: '', headers: { 'content-type': 'application/json' } },
      400,
      'bad_request',
    ],
  ]
  it.each(BODIES)('%s', async (_name, request, status, error) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/PAY/tasks/reorder',
      ...request,
    })
    expect(response.statusCode).toBe(status)
    if (error !== undefined) expect(response.json().error).toBe(error)
  })

  it('rolls everything back when a write fails partway', async () => {
    await seedMessy()
    const db = getTestDb()
    await sql`create function fail_on_d2() returns trigger as $$
      begin if new.title = 'd2' then raise exception 'boom'; end if; return new; end $$
      language plpgsql`.execute(db)
    await sql`create trigger fail_on_d2 before update on tasks
      for each row execute function fail_on_d2()`.execute(db)
    const spy = collect()
    try {
      const response = await reorder()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(response.statusCode).toBe(500)
      expect(response.json().error).toBe('internal_error')
    } finally {
      spy.stop()
      await sql`drop trigger fail_on_d2 on tasks`.execute(db)
      await sql`drop function fail_on_d2()`.execute(db)
    }
    expect(await positions()).toEqual({ b1: 0.5, b2: 0.75, b3: 3, d1: 2, d2: 7, f1: 1 })
    expect(spy.ids).toEqual([])
  })

  it('waits for a concurrent move and numbers the moved card last', async () => {
    const db = getTestDb()
    await seedTask(db, projectId, { number: 1, title: 'a', position: 0.5 })
    await seedTask(db, projectId, { number: 2, title: 'b', position: 4 })
    await seedTask(db, projectId, { number: 3, title: 'm', state: 'spec_review', position: 1 })
    await seedTask(db, projectId, { number: 4, title: 'z', position: 9 })
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const ready = new Promise<void>((resolve) => (locked = resolve))
    const mover = db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('tasks')
        .select('id')
        .where('title', '=', 'm')
        .forUpdate()
        .executeTakeFirstOrThrow()
      const { last } = await trx
        .selectFrom('tasks')
        .select(sql<number>`coalesce(max(position), 0)`.as('last'))
        .where('state', '=', 'backlog')
        .executeTakeFirstOrThrow()
      await trx
        .updateTable('tasks')
        .set({ state: 'backlog', position: last + 1 })
        .where('id', '=', row.id)
        .execute()
      locked()
      await hold
    })
    await ready
    let answered = false
    const pending = reorder().then((response) => {
      answered = true
      return response
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(answered).toBe(false)
    release()
    await mover
    const response = await pending
    expect(response.statusCode).toBe(200)
    expect(await positions()).toEqual({ a: 1, b: 2, z: 3, m: 4 })
  })

  it('waits for a task being created and numbers it last', async () => {
    const db = getTestDb()
    await seedTask(db, projectId, { number: 1, title: 'a', position: 0.5 })
    await seedTask(db, projectId, { number: 2, title: 'b', position: 4 })
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    let created!: () => void
    const ready = new Promise<void>((resolve) => (created = resolve))
    // What TaskRepository.insert does: takes the project row, then adds the task after the last.
    const creator = db.transaction().execute(async (trx) => {
      await trx
        .updateTable('projects')
        .set((eb) => ({ next_task_number: eb('next_task_number', '+', 1) }))
        .where('id', '=', projectId)
        .execute()
      await seedTask(trx, projectId, { number: 3, title: 'new', position: 5 })
      created()
      await hold
    })
    await ready
    let answered = false
    const pending = reorder().then((response) => {
      answered = true
      return response
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(answered).toBe(false)
    } finally {
      release()
      await creator
    }
    const response = await pending
    expect(response.statusCode).toBe(200)
    expect(await positions()).toEqual({ a: 1, b: 2, new: 3 })
  })
})
