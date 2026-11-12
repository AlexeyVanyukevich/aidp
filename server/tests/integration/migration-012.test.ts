import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { migrations } from '../../src/db/migrations/index.js'

beforeEach(resetDb)
afterAll(closeTestDb)

const migrator = () =>
  new Migrator({ db: getTestDb(), provider: { getMigrations: async () => migrations } })

interface Ids {
  projectId: string
  taskId: string
  runId: string
  phaseId: string
  approvalId: string
}

async function fixture(): Promise<Ids> {
  const db = getTestDb()
  const project = await sql<{ id: string }>`
    insert into projects (key, name, repo_path, github_repo, base_branch)
    values ('PAY', 'Payments', '/tmp/pay', 'owner/pay', 'main') returning id`.execute(db)
  const projectId = project.rows[0]!.id
  const task = await sql<{ id: string }>`
    insert into tasks (project_id, number, title, state, position, updated_at)
    values (${projectId}, 1, 'A', 'running', 1, now()) returning id`.execute(db)
  const taskId = task.rows[0]!.id
  const run = await sql<{ id: string }>`
    insert into runs (task_id, kind, number, status, spec_version)
    values (${taskId}, 'delivery', 1, 'running', 1) returning id`.execute(db)
  const runId = run.rows[0]!.id
  const phase = await sql<{ id: string }>`
    insert into phases (id, run_id, name, attempt, agent, model, status, started_at) values (gen_random_uuid(), ${runId}, 'build', 1, 'builder', 'm', 'running', now()) returning id`.execute(
    db,
  )
  const approval = await sql<{ id: string }>`
    insert into approval_requests (run_id, kind, question, status)
    values (${runId}, 'proposal', 'Q', 'open') returning id`.execute(db)
  return { projectId, taskId, runId, phaseId: phase.rows[0]!.id, approvalId: approval.rows[0]!.id }
}

interface Row {
  name: string
  related: boolean
  number: number
  outcome: string | null
  settled: boolean
  filedTask: boolean
  approval: boolean
  bearing: string | null
  workaround: string | null
  ok: boolean
}

const base: Omit<Row, 'name' | 'ok'> = {
  related: false,
  number: 1,
  outcome: null,
  settled: false,
  filedTask: false,
  approval: false,
  bearing: null,
  workaround: null,
}

const rows: Row[] = [
  { name: 'an open unrelated proposal', ...base, ok: true },
  {
    name: 'a wait outcome with a filed task',
    ...base,
    outcome: 'wait',
    settled: true,
    filedTask: true,
    ok: true,
  },
  { name: 'an outcome other', ...base, outcome: 'other', settled: true, ok: false },
  { name: 'a number of 11', ...base, number: 11, ok: false },
  { name: 'a workaround on an unrelated proposal', ...base, workaround: 'w', ok: false },
  {
    name: 'a related proposal without an approval',
    ...base,
    related: true,
    bearing: 'b',
    ok: false,
  },
  {
    name: 'a related proposal without a bearing',
    ...base,
    related: true,
    approval: true,
    ok: false,
  },
  { name: 'an outcome without settled_at', ...base, outcome: 'dismiss', ok: false },
  {
    name: 'a file outcome without a filed task',
    ...base,
    outcome: 'file',
    settled: true,
    ok: false,
  },
]

async function insert(ids: Ids, row: Row, filedId: string): Promise<void> {
  await sql`insert into proposals (run_id, phase_id, task_id, project_id, number, title,
      description_md, related, bearing_md, workaround_md, approval_id, outcome, filed_task_id, settled_at)
    values (${ids.runId}, ${ids.phaseId}, ${ids.taskId}, ${ids.projectId}, ${row.number}, 'T', 'D',
      ${row.related}, ${row.bearing}, ${row.workaround}, ${row.approval ? ids.approvalId : null},
      ${row.outcome}, ${row.filedTask ? filedId : null}, ${row.settled ? sql`now()` : null})`.execute(
    getTestDb(),
  )
}

async function otherTask(ids: Ids): Promise<string> {
  const task = await sql<{ id: string }>`
    insert into tasks (project_id, number, title, state, position, updated_at)
    values (${ids.projectId}, 2, 'B', 'backlog', 2, now()) returning id`.execute(getTestDb())
  return task.rows[0]!.id
}

describe('migration 012', () => {
  it.each(rows)('$name', async (row) => {
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    const ids = await fixture()
    const filed = await otherTask(ids)
    if (row.ok) await insert(ids, row, filed)
    else await expect(insert(ids, row, filed)).rejects.toThrow()
  })

  it('deletes a proposal with its run, and refuses to delete a task it filed', async () => {
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    const ids = await fixture()
    const filed = await otherTask(ids)
    await insert(
      ids,
      { ...base, name: '', outcome: 'file', settled: true, filedTask: true, ok: true },
      filed,
    )
    await expect(sql`delete from tasks where id = ${filed}`.execute(getTestDb())).rejects.toThrow()
    await sql`delete from runs where id = ${ids.runId}`.execute(getTestDb())
    const { rows: left } = await sql`select 1 from proposals`.execute(getTestDb())
    expect(left).toHaveLength(0)
  })

  it('creates its indexes', async () => {
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    const { rows: found } = await sql<{ indexname: string }>`
      select indexname from pg_indexes where tablename = 'proposals'`.execute(getTestDb())
    expect(found.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(['proposals_by_task', 'proposals_by_project']),
    )
  })

  it('refuses down while a proposal exists, and drops the table otherwise', async () => {
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    const ids = await fixture()
    await insert(ids, { ...base, name: '', ok: true }, '')
    expect((await migrator().migrateTo('011_decision_helps')).error).toBeDefined()
    await sql`delete from proposals`.execute(getTestDb())
    expect((await migrator().migrateTo('011_decision_helps')).error).toBeUndefined()
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
  })
})
