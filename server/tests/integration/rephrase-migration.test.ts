import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { migrations } from '../../src/db/migrations/index.js'

beforeEach(resetDb)
afterAll(closeTestDb)

const migrator = () =>
  new Migrator({ db: getTestDb(), provider: { getMigrations: async () => migrations } })

const columns = async () =>
  (
    await sql<{ c: string }>`select column_name as c from information_schema.columns
      where table_name = 'runs'`.execute(getTestDb())
  ).rows.map((row) => row.c)

async function task(): Promise<string> {
  const db = getTestDb()
  const project = await sql<{ id: string }>`
    insert into projects (key, name, repo_path, github_repo, base_branch)
    values ('PAY', 'Payments', '/tmp/pay', 'owner/pay', 'main') returning id`.execute(db)
  const made = await sql<{ id: string }>`
    insert into tasks (project_id, number, title, state, position, updated_at)
    values (${project.rows[0]!.id}, 1, 'A', 'backlog', 1, now()) returning id`.execute(db)
  return made.rows[0]!.id
}

const SUGGESTION_COLUMNS = [
  'base_md',
  'suggestion_md',
  'suggestion_status',
  'suggestion_decided_at',
]

describe('the rephrase migration', () => {
  afterEach(async () => {
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
  })

  it('accepts a rephrase run and phase, and keeps the title kind and help phase', async () => {
    const db = getTestDb()
    expect((await migrator().migrateTo('009_helps')).error).toBeUndefined()
    const taskId = await task()
    await expect(
      sql`insert into runs (task_id, kind, number, status) values (${taskId}, 'rephrase', 1, 'queued')`.execute(
        db,
      ),
    ).rejects.toThrow(/runs_kind_known/)
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    expect(await columns()).toEqual(expect.arrayContaining(SUGGESTION_COLUMNS))
    const run = await sql<{ id: string }>`
      insert into runs (task_id, kind, number, status, current_phase, base_md)
      values (${taskId}, 'rephrase', 1, 'running', 'rephrase', 'text') returning id`.execute(db)
    const runId = run.rows[0]!.id
    await sql`insert into phases (id, run_id, name, attempt, agent, model, status, started_at)
      values (gen_random_uuid(), ${runId}, 'rephrase', 1, 'rephraser', 'sonnet', 'running', now())`.execute(
      db,
    )
    await sql`insert into runs (task_id, kind, number, status) values (${taskId}, 'title', 1, 'queued')`.execute(
      db,
    )
    await sql`insert into phases (id, run_id, name, attempt, agent, model, status, started_at)
      values (gen_random_uuid(), ${runId}, 'help', 1, 'helper', 'sonnet', 'running', now())`.execute(
      db,
    )
  })

  it('checks the suggestion status and keeps the columns null off a rephrase run', async () => {
    const db = getTestDb()
    const taskId = await task()
    await expect(
      sql`insert into runs (task_id, kind, number, status, spec_version, suggestion_md)
        values (${taskId}, 'delivery', 1, 'queued', 1, 'x')`.execute(db),
    ).rejects.toThrow(/runs_suggestion_only_rephrase/)
    await expect(
      sql`insert into runs (task_id, kind, number, status, spec_version, base_md)
        values (${taskId}, 'delivery', 1, 'queued', 1, 'x')`.execute(db),
    ).rejects.toThrow(/runs_suggestion_only_rephrase/)
    await expect(
      sql`insert into runs (task_id, kind, number, status, suggestion_status)
        values (${taskId}, 'rephrase', 1, 'succeeded', 'bogus')`.execute(db),
    ).rejects.toThrow(/runs_suggestion_status_known/)
    for (const [index, status] of ['pending', 'accepted', 'discarded', 'replaced'].entries())
      await sql`insert into runs (task_id, kind, number, status, suggestion_status)
        values (${taskId}, 'rephrase', ${index + 1}, 'succeeded', ${status})`.execute(db)
  })

  it('rolls back to the earlier checks and drops the columns when no rephrase run exists', async () => {
    const db = getTestDb()
    const taskId = await task()
    await sql`insert into runs (task_id, kind, number, status) values (${taskId}, 'title', 1, 'queued')`.execute(
      db,
    )
    expect((await migrator().migrateTo('009_helps')).error).toBeUndefined()
    const present = await columns()
    for (const name of SUGGESTION_COLUMNS) expect(present).not.toContain(name)
    await expect(
      sql`insert into runs (task_id, kind, number, status) values (${taskId}, 'rephrase', 1, 'queued')`.execute(
        db,
      ),
    ).rejects.toThrow(/runs_kind_known/)
    await expect(
      sql`update runs set current_phase = 'rephrase' where task_id = ${taskId}`.execute(db),
    ).rejects.toThrow(/runs_phase_known/)
    const kept = await sql<{ n: number }>`select count(*)::int as n from runs`.execute(db)
    expect(kept.rows[0]!.n).toBe(1)
  })

  it('refuses to roll back while a rephrase run exists, and deletes nothing', async () => {
    const db = getTestDb()
    const taskId = await task()
    const run = await sql<{ id: string }>`
      insert into runs (task_id, kind, number, status, base_md)
      values (${taskId}, 'rephrase', 1, 'succeeded', 'text') returning id`.execute(db)
    await sql`insert into phases (id, run_id, name, attempt, agent, model, status, started_at)
      values (gen_random_uuid(), ${run.rows[0]!.id}, 'rephrase', 1, 'rephraser', 'sonnet', 'succeeded', now())`.execute(
      db,
    )
    const result = await migrator().migrateTo('009_helps')
    expect(String(result.error)).toMatch(/rephrase runs exist/)
    for (const table of ['runs', 'phases']) {
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from ${sql.table(table)}`.execute(db)
      expect(rows[0]!.n).toBe(1)
    }
    expect(await columns()).toEqual(expect.arrayContaining(SUGGESTION_COLUMNS))
  })
})
