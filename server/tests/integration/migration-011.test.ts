import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { migrations } from '../../src/db/migrations/index.js'

beforeEach(resetDb)
afterAll(closeTestDb)

const migrator = () =>
  new Migrator({ db: getTestDb(), provider: { getMigrations: async () => migrations } })

afterEach(async () => {
  expect((await migrator().migrateToLatest()).error).toBeUndefined()
})

/** Columns and checks of the tables the migration touches, as a comparable text. */
async function schema(): Promise<string> {
  const db = getTestDb()
  const columns = await sql<{ line: string }>`
    select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable as line
    from information_schema.columns where table_name in ('helps', 'runs') order by 1`.execute(db)
  const checks = await sql<{ line: string }>`
    select conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) as line
    from pg_constraint where contype = 'c' and conrelid::regclass::text in ('helps', 'runs')
    order by 1`.execute(db)
  return [...columns.rows, ...checks.rows].map((row) => row.line).join('\n')
}

async function fixture(): Promise<{ taskId: string; runId: string; approvalId: string }> {
  const db = getTestDb()
  const project = await sql<{ id: string }>`
    insert into projects (key, name, repo_path, github_repo, base_branch)
    values ('PAY', 'Payments', '/tmp/pay', 'owner/pay', 'main') returning id`.execute(db)
  const task = await sql<{ id: string }>`
    insert into tasks (project_id, number, title, state, position, updated_at)
    values (${project.rows[0]!.id}, 1, 'A', 'spec_review', 1, now()) returning id`.execute(db)
  const taskId = task.rows[0]!.id
  const run = await sql<{ id: string }>`
    insert into runs (task_id, kind, number, status, spec_version)
    values (${taskId}, 'delivery', 1, 'blocked', 1) returning id`.execute(db)
  const runId = run.rows[0]!.id
  const approval = await sql<{ id: string }>`
    insert into approval_requests (run_id, kind, question, status)
    values (${runId}, 'question', 'Which?', 'open') returning id`.execute(db)
  return { taskId, runId, approvalId: approval.rows[0]!.id }
}

describe('migration 011', () => {
  it('keeps existing helps as question helps, and down restores 010', async () => {
    expect((await migrator().migrateTo('010_rephrase')).error).toBeUndefined()
    const before = await schema()
    const { runId, approvalId } = await fixture()
    await sql`insert into helps (run_id, approval_id, mode, status) values (${runId}, ${approvalId}, 'suggest', 'queued')`.execute(
      getTestDb(),
    )
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    const { rows } = await sql<{ decision: string }>`select decision from helps`.execute(
      getTestDb(),
    )
    expect(rows.map((row) => row.decision)).toEqual(['question'])
    expect(await schema()).not.toBe(before)
    await sql`delete from helps`.execute(getTestDb())
    expect((await migrator().migrateTo('010_rephrase')).error).toBeUndefined()
    expect(await schema()).toBe(before)
  })

  const refused: { name: string; decision: string; mode: string; approval: boolean }[] = [
    {
      name: 'a decision help with an approval',
      decision: 'spec_review',
      mode: 'review',
      approval: true,
    },
    { name: 'a question help without one', decision: 'question', mode: 'suggest', approval: false },
    {
      name: 'a question help with a decision mode',
      decision: 'question',
      mode: 'review',
      approval: true,
    },
    {
      name: 'a decision help with a question mode',
      decision: 'spec_review',
      mode: 'explain',
      approval: false,
    },
    {
      name: 'a stopped-run help with a check mode',
      decision: 'stopped_run',
      mode: 'check',
      approval: false,
    },
  ]
  it.each(refused)('refuses $name', async ({ decision, mode, approval }) => {
    const { runId, approvalId } = await fixture()
    await expect(
      sql`insert into helps (run_id, approval_id, decision, mode, status)
        values (${runId}, ${approval ? approvalId : null}, ${decision}, ${mode}, 'queued')`.execute(
        getTestDb(),
      ),
    ).rejects.toThrow(/helps_/)
  })

  it('refuses to roll back while a decision help exists, and changes nothing', async () => {
    const db = getTestDb()
    const { taskId } = await fixture()
    const run = await sql<{ id: string }>`
      insert into runs (task_id, kind, number, status, queued_at)
      values (${taskId}, 'help', 1, 'queued', null) returning id`.execute(db)
    await sql`insert into helps (run_id, decision, mode, status, subject)
      values (${run.rows[0]!.id}, 'spec_review', 'review', 'queued', '{"spec_version":3}')`.execute(
      db,
    )
    const before = await schema()
    const result = await migrator().migrateTo('010_rephrase')
    expect(String(result.error)).toContain(
      'Cannot roll back 011: decision helps exist, and removing them would lose their phases, events and cost.',
    )
    expect(await schema()).toBe(before)
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from helps`.execute(db)
    expect(rows[0]!.n).toBe(1)
  })
})
