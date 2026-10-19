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
    const columns = async () =>
      (
        await sql<{ c: string }>`select table_name || '.' || column_name as c
          from information_schema.columns where table_schema = 'public' order by 1`.execute(
          getTestDb(),
        )
      ).rows.map((row) => row.c)
    const before = await columns()
    const migrator = new Migrator({
      db: getTestDb(),
      provider: { getMigrations: async () => migrations },
    })
    expect((await migrator.migrateDown()).error).toBeUndefined()
    expect(await columns()).not.toContain('runs.checkpoint')
    expect((await migrator.migrateToLatest()).error).toBeUndefined()
    expect(await columns()).toEqual(before)
  })
})
