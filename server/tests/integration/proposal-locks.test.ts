import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest'
import type { Database } from '../../src/db/schema.js'
import { performAction } from '../../src/modules/tasks/task.actions.js'
import { ProposalService } from '../../src/modules/proposals/proposal.service.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { propose, relatedWorld } from './proposal-world.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

/** A connection pool whose every statement is recorded, in order. */
function logging() {
  const statements: string[] = []
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: inject('databaseUrl') }),
    }),
    log: (event) => {
      if (event.level === 'query') statements.push(event.query.sql)
    },
  })
  return { db, statements }
}

const FIRST: Record<string, RegExp> = {
  proposals: /from "proposals"[^]*for update/,
  projects: /from "projects"[^]*for no key update/,
  tasks: /(from "tasks"[^]*for update|update "tasks")/,
  runs: /(from "runs"[^]*for update|update "runs")/,
  approvals: /(update "approval_requests"|from "approval_requests"[^]*for update)/,
  helps: /("helps")/,
}
const firstIndex = (statements: string[], table: string) =>
  statements.findIndex((sql) => FIRST[table]!.test(sql))

describe('the lock order', () => {
  it('settle takes proposal, project, task, run, then the rest (AC20)', async () => {
    const w = await relatedWorld('plan')
    const { db, statements } = logging()
    await new ProposalService(db, () => new Date()).settle(w.taskId, w.proposalId, 'file')
    await db.destroy()
    const order = ['proposals', 'projects', 'tasks', 'runs', 'approvals'].map((t) =>
      firstIndex(statements, t),
    )
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('propose_task takes project, task, run before the approval (AC20)', async () => {
    const w = await relatedWorld('plan')
    await getTestDb()
      .updateTable('approval_requests')
      .set({ status: 'answered' })
      .where('run_id', '=', w.runId)
      .execute()
    await getTestDb()
      .updateTable('tasks')
      .set({ state: 'running' })
      .where('id', '=', w.taskId)
      .execute()
    await getTestDb()
      .updateTable('phases')
      .set({ status: 'running' })
      .where('id', '=', w.phaseId)
      .execute()
    const { db, statements } = logging()
    await new ProposalService(db, () => new Date()).propose({
      runId: w.runId,
      taskId: w.taskId,
      phaseId: w.phaseId,
      agent: 'planner',
      targetProjectId: w.projectId,
      title: 'Another',
      description_md: '**Where:** a\n**Found:** b\n**Problem:** c\n**Impact:** d',
      related: true,
      bearing_md: 'b',
      workaround_md: null,
    })
    await db.destroy()
    const order = ['projects', 'tasks', 'runs', 'approvals'].map((t) => firstIndex(statements, t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('a settle and a propose_task of one run finish together (AC20)', async () => {
    const w = await relatedWorld('plan')
    await getTestDb()
      .updateTable('approval_requests')
      .set({ status: 'withdrawn' })
      .where('run_id', '=', w.runId)
      .execute()
    const service = new ProposalService(getTestDb(), () => new Date())
    const results = await Promise.allSettled([
      service.settle(w.taskId, w.proposalId, 'file'),
      propose(w, { title: 'Concurrent finding', bearing_md: 'x' }),
    ])
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
  })

  it('Cancel locks the task before the run (AC38)', async () => {
    const w = await relatedWorld('plan')
    const { db, statements } = logging()
    await performAction(db, w.taskId, 'cancel', new Date())
    await db.destroy()
    expect(firstIndex(statements, 'tasks')).toBeGreaterThanOrEqual(0)
    expect(firstIndex(statements, 'tasks')).toBeLessThan(firstIndex(statements, 'runs'))
  })

  it('a settle and a Cancel never deadlock, in 20 repetitions (AC38)', async () => {
    for (let i = 0; i < 20; i++) {
      await resetDb()
      const w = await relatedWorld('plan')
      const before = (await getTestDb().selectFrom('tasks').select('id').execute()).length
      const results = await Promise.allSettled([
        new ProposalService(getTestDb(), () => new Date()).settle(w.taskId, w.proposalId, 'file'),
        performAction(getTestDb(), w.taskId, 'cancel', new Date()),
      ])
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
      expect((await getTestDb().selectFrom('tasks').select('id').execute()).length).toBe(before + 1)
      const run = await getTestDb()
        .selectFrom('runs')
        .select(['status', 'resume_message'])
        .where('id', '=', w.runId)
        .executeTakeFirstOrThrow()
      expect(run.status).toBe('cancelled')
    }
  }, 60_000)
})
