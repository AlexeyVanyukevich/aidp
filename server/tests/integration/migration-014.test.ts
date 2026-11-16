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

async function schema(): Promise<string> {
  const db = getTestDb()
  const columns = await sql<{ line: string }>`
    select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable as line
    from information_schema.columns where table_name in ('helps', 'projects') order by 1`.execute(
    db,
  )
  const checks = await sql<{ line: string }>`
    select conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) as line
    from pg_constraint where contype = 'c' and conrelid::regclass::text in ('helps', 'projects')
    order by 1`.execute(db)
  return [...columns.rows, ...checks.rows].map((row) => row.line).join('\n')
}

async function project(key: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    insert into projects (key, name, repo_path, github_repo, base_branch)
    values (${key}, ${key}, ${'/tmp/' + key}, ${'owner/' + key}, 'main') returning id`.execute(
    getTestDb(),
  )
  return rows[0]!.id
}

async function fixture(): Promise<{ runId: string; approvalId: string }> {
  const db = getTestDb()
  const projectId = await project('PAY')
  const task = await sql<{ id: string }>`
    insert into tasks (project_id, number, title, state, position, updated_at)
    values (${projectId}, 1, 'A', 'needs_approval', 1, now()) returning id`.execute(db)
  const run = await sql<{ id: string }>`
    insert into runs (task_id, kind, number, status, spec_version)
    values (${task.rows[0]!.id}, 'delivery', 1, 'blocked', 1) returning id`.execute(db)
  const runId = run.rows[0]!.id
  const approval = await sql<{ id: string }>`
    insert into approval_requests (run_id, kind, question, status)
    values (${runId}, 'questions', 'Which?', 'open') returning id`.execute(db)
  return { runId, approvalId: approval.rows[0]!.id }
}

const insertHelp = (runId: string, approvalId: string, mode: string, decision = 'question') =>
  sql`insert into helps (run_id, approval_id, decision, mode, status)
    values (${runId}, ${approvalId}, ${decision}, ${mode}, 'queued')`.execute(getTestDb())

describe('migration 014', () => {
  it('gives existing projects whole, and a later one too', async () => {
    expect((await migrator().migrateTo('013_pull_request_review')).error).toBeUndefined()
    await project('ONE')
    await project('TWO')
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    await project('THREE')
    const { rows } = await sql<{ batch_suggest: string }>`
      select batch_suggest from projects`.execute(getTestDb())
    expect(rows.map((r) => r.batch_suggest)).toEqual(['whole', 'whole', 'whole'])
    await expect(
      sql`update projects set batch_suggest = 'all'`.execute(getTestDb()),
    ).rejects.toThrow()
  })

  it('allows suggest_all for a question only, and down restores 013', async () => {
    expect((await migrator().migrateTo('013_pull_request_review')).error).toBeUndefined()
    const before = await schema()
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    const { runId, approvalId } = await fixture()
    await insertHelp(runId, approvalId, 'suggest_all')
    await expect(insertHelp(runId, approvalId, 'suggest_all', 'spec_review')).rejects.toThrow()
    await sql`delete from helps`.execute(getTestDb())
    expect((await migrator().migrateTo('013_pull_request_review')).error).toBeUndefined()
    expect(await schema()).toBe(before)
    await expect(insertHelp(runId, approvalId, 'suggest_all')).rejects.toThrow()
  })

  it('refuses down while a suggest_all help exists, and changes nothing', async () => {
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    const { runId, approvalId } = await fixture()
    await insertHelp(runId, approvalId, 'suggest_all')
    const before = await schema()
    const result = await migrator().migrateTo('013_pull_request_review')
    expect(String(result.error)).toContain('whole-batch suggestions exist')
    expect(await schema()).toBe(before)
    await sql`delete from helps`.execute(getTestDb())
  })
})
