import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { EVENT_TYPES, TASK_STATES } from '../../src/shared/vocabulary.js'

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
