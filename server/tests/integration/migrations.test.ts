import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { migrations } from '../../src/db/migrations/index.js'
import {
  APPROVAL_STATUSES,
  EVENT_TYPES,
  PHASE_STATUSES,
  RUN_STATUSES,
  TASK_STATES,
  type RunStatus,
} from '../../src/shared/vocabulary.js'

beforeEach(resetDb)
afterAll(closeTestDb)

async function project() {
  return getTestDb()
    .insertInto('projects')
    .values({
      key: 'PAY',
      name: 'Payments',
      repo_path: '/tmp/pay',
      github_repo: 'owner/pay',
      base_branch: 'main',
      test_command: 'npm test',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}

describe('the initial migration', () => {
  it('creates every table in the spec', async () => {
    const { rows } = await sql<{ table_name: string }>`
      select table_name from information_schema.tables where table_schema = 'public'
    `.execute(getTestDb())
    expect(rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'projects',
        'tasks',
        'specs',
        'runs',
        'run_tokens',
        'phases',
        'events',
        'approval_requests',
        'artifacts',
        'prices',
      ]),
    )
  })

  // Derived from the code's own list, so the constraint and the type cannot drift apart
  // without this failing.
  it.each(TASK_STATES)('accepts the task state %s', async (state) => {
    const { id } = await project()
    await expect(
      getTestDb()
        .insertInto('tasks')
        .values({
          project_id: id,
          number: 1,
          title: 'T',
          state,
          position: 1,
          updated_at: new Date(),
        })
        .execute(),
    ).resolves.toBeDefined()
  })

  it.each(EVENT_TYPES)('accepts the event type %s', async (type) => {
    const { id } = await project()
    const task = await getTestDb()
      .insertInto('tasks')
      .values({
        project_id: id,
        number: 1,
        title: 'T',
        state: 'running',
        position: 1,
        updated_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const run = await getTestDb()
      .insertInto('runs')
      .values({
        task_id: task.id,
        kind: 'delivery',
        number: 1,
        spec_version: 1,
        status: 'running',
        current_phase: null,
        branch: null,
        worktree_path: null,
        pr_number: null,
        pr_url: null,
        failure_reason: null,
        runner_id: null,
        started_at: null,
        ended_at: null,
        last_heartbeat_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await expect(
      getTestDb()
        .insertInto('events')
        .values({
          id: crypto.randomUUID(),
          run_id: run.id,
          phase_id: null,
          ts: new Date(),
          type,
          agent: null,
          model: null,
          tool: null,
          target: null,
          status: null,
          duration_ms: null,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          payload: '{}',
        })
        .execute(),
    ).resolves.toBeDefined()
  })

  it.each([
    ['a lower-case key', { key: 'pay' }],
    ['a one-letter key', { key: 'P' }],
    ['a repository without an owner', { github_repo: 'pay' }],
  ])('refuses a project with %s', async (_name, change) => {
    await expect(
      getTestDb()
        .insertInto('projects')
        .values({
          key: 'PAY',
          name: 'P',
          repo_path: '/tmp/p',
          github_repo: 'o/p',
          base_branch: 'main',
          test_command: 'npm test',
          ...change,
        })
        .execute(),
    ).rejects.toThrow(/violates check constraint/)
  })

  it('refuses a task state it does not know', async () => {
    const { id } = await project()
    await expect(
      sql`insert into tasks (project_id, number, title, state, position)
          values (${id}, 1, 'T', 'archived', 1)`.execute(getTestDb()),
    ).rejects.toThrow(/tasks_state_known/)
  })
})

/** A task and a run on it, the run in `status`. */
async function run(status: RunStatus = 'running') {
  const { id } = await project()
  const task = await getTestDb()
    .insertInto('tasks')
    .values({
      project_id: id,
      number: 1,
      title: 'T',
      state: 'running',
      position: 1,
      updated_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return getTestDb()
    .insertInto('runs')
    .values({
      task_id: task.id,
      kind: 'delivery',
      number: 1,
      spec_version: 1,
      status,
      current_phase: null,
      branch: null,
      worktree_path: null,
      pr_number: null,
      pr_url: null,
      failure_reason: null,
      runner_id: null,
      started_at: null,
      ended_at: null,
      last_heartbeat_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}

describe('the pause-and-resume migration', () => {
  it.each(RUN_STATUSES)('accepts the run status %s', async (status) => {
    await expect(run(status)).resolves.toBeDefined()
  })

  it.each(PHASE_STATUSES)('accepts the phase status %s', async (status) => {
    const { id } = await run()
    await expect(
      getTestDb()
        .insertInto('phases')
        .values({
          id: crypto.randomUUID(),
          run_id: id,
          name: 'build',
          attempt: 1,
          agent: 'builder',
          model: 'sonnet',
          status,
          session_id: null,
          summary_md: null,
          reported_cost: null,
          started_at: new Date(),
          ended_at: null,
        })
        .execute(),
    ).resolves.toBeDefined()
  })

  it.each(APPROVAL_STATUSES)('accepts the approval status %s', async (status) => {
    const { id } = await run()
    await expect(
      getTestDb()
        .insertInto('approval_requests')
        .values({
          run_id: id,
          phase_id: null,
          kind: 'question',
          question: 'Which colour?',
          options: '[]',
          recommendation: null,
          context_md: null,
          status,
          answer: null,
          checkpoint: null,
          files: null,
          answered_at: null,
        })
        .execute(),
    ).resolves.toBeDefined()
  })

  it.each([
    ['pending work it does not know', sql`update runs set pending = 'other'`, /runs_pending_known/],
    ['a run status it does not know', sql`update runs set status = 'parked'`, /runs_status_known/],
  ])('refuses %s', async (_name, statement, constraint) => {
    await run()
    await expect(statement.execute(getTestDb())).rejects.toThrow(constraint)
  })

  it('goes down and up again to the same columns', async () => {
    const before = await columns()
    expect((await migrator().migrateTo('001_initial')).error).toBeUndefined()
    expect(await columns()).not.toContain('runs.checkpoint')
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    expect(await columns()).toEqual(before)
  })
})

const columns = async () =>
  (
    await sql<{ c: string }>`select table_name || '.' || column_name as c
      from information_schema.columns where table_schema = 'public' order by 1`.execute(getTestDb())
  ).rows.map((row) => row.c)

const migrator = () =>
  new Migrator({ db: getTestDb(), provider: { getMigrations: async () => migrations } })

describe('the drafted-specs migration', () => {
  it('numbers the runs already there by task and kind, in creation order', async () => {
    expect((await migrator().migrateTo('002_pause_and_resume')).error).toBeUndefined()
    const db = getTestDb()
    const { id: projectId } = await project()
    const { rows: tasks } = await sql<{ id: string }>`
      insert into tasks (project_id, number, title, state, position, updated_at)
      values (${projectId}, 1, 'A', 'running', 1, now()), (${projectId}, 2, 'B', 'running', 2, now())
      returning id`.execute(db)
    const [a, b] = tasks.map((task) => task.id)
    // Created in this order: two drafts and two runs on A, interleaved, and one run on B.
    const kinds = [
      [a, 'delivery'],
      [a, 'spec'],
      [b, 'delivery'],
      [a, 'delivery'],
      [a, 'spec'],
    ] as const
    for (const [index, [task, kind]] of kinds.entries())
      await sql`insert into runs (task_id, kind, spec_version, status, created_at)
        values (${task}, ${kind}, 1, 'succeeded', now() + make_interval(secs => ${index}))`.execute(
        db,
      )
    await sql`insert into specs (task_id, version, body_md, status)
      values (${a}, 1, '## Requirements', 'draft')`.execute(db)

    expect((await migrator().migrateToLatest()).error).toBeUndefined()

    const { rows } = await sql<{ number: number }>`
      select number from runs order by created_at`.execute(db)
    expect(rows.map((row) => row.number)).toEqual([1, 1, 1, 2, 2])
    const spec = await db.selectFrom('specs').select('run_id').executeTakeFirstOrThrow()
    expect(spec.run_id).toBeNull()
  })

  it('refuses a delivery run without a spec version, and accepts a spec run without one', async () => {
    const { id } = await run()
    const { task_id: taskId } = await getTestDb()
      .selectFrom('runs')
      .select('task_id')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    const insert = (kind: 'spec' | 'delivery') =>
      sql`insert into runs (task_id, kind, number, spec_version, status)
        values (${taskId}, ${kind}, 2, null, 'queued')`.execute(getTestDb())
    await expect(insert('delivery')).rejects.toThrow(/runs_delivery_has_spec/)
    await expect(insert('spec')).resolves.toBeDefined()
  })

  // In SQL: the kind joins the code's vocabulary with its rules, in a later commit.
  it('keeps a batch of questions', async () => {
    const { id } = await run()
    await sql`insert into approval_requests (run_id, kind, question, options, questions, status)
      values (${id}, 'questions', '1 question about the spec', '[]',
        ${JSON.stringify([{ id: 'q1', question: 'How often?', options: [] }])}, 'open')`.execute(
      getTestDb(),
    )
    const row = await getTestDb()
      .selectFrom('approval_requests')
      .select('questions')
      .executeTakeFirstOrThrow()
    expect(row.questions).toEqual([{ id: 'q1', question: 'How often?', options: [] }])
  })

  it('goes down and up again to the same columns', async () => {
    const before = await columns()
    expect((await migrator().migrateTo('002_pause_and_resume')).error).toBeUndefined()
    expect(await columns()).not.toContain('runs.number')
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    expect(await columns()).toEqual(before)
  })
})

describe('running migrations', () => {
  it('names a failed migration and carries the database’s error', async () => {
    const { runMigrations } = await import('../../src/db/migrate.js')
    const failing = {
      '999_broken': {
        up: async (db: never) => {
          await sql`select * from no_such_table`.execute(db)
        },
      },
    }
    await expect(runMigrations(getTestDb(), { ...migrations, ...failing })).rejects.toThrow(
      /Migration "999_broken" failed: .*no_such_table/,
    )
    const row = await sql`select 1 from kysely_migration where name = '999_broken'`.execute(
      getTestDb(),
    )
    expect(row.rows).toEqual([])
  })
})
