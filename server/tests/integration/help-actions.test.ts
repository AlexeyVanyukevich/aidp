import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { seedProject, seedQueuedRun, seedTask } from './fixtures.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'

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

const TEXT = '**Where:** a.ts\n**Found:** today\n**Problem:** p\n**Impact:** i'
const outsideFinding = (title: string, extra: Record<string, unknown> = {}) => ({
  kind: 'risk',
  text: TEXT,
  destination: 'outside',
  evidence: 'a.ts:1',
  title,
  ...extra,
})

/** A card in Spec review of the project AIDP, linked to CHR, with a succeeded review help. */
async function world(findings: unknown[], mode = 'review') {
  const own = await seedProject(db(), { key: 'AIDP' })
  const chr = await seedProject(db(), { key: 'CHR' })
  await db()
    .insertInto('project_links')
    .values({ project_id: own.id, linked_project_id: chr.id, note: 'n' })
    .execute()
  const { taskId, runId } = await seedQueuedRun(db(), {
    state: 'spec_review',
    projectId: own.id,
    number: 12,
  })
  await db().deleteFrom('runs').where('id', '=', runId).execute()
  await db()
    .updateTable('specs')
    .set({ status: 'draft', approved_at: null })
    .where('task_id', '=', taskId)
    .execute()
  const helpRun = await db()
    .insertInto('runs')
    .values({ task_id: taskId, kind: 'help', number: 1, status: 'succeeded' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const help = await db()
    .insertInto('helps')
    .values({
      run_id: helpRun.id,
      decision: 'spec_review',
      mode: mode as 'review',
      status: 'succeeded',
      subject: JSON.stringify({ spec_version: 1 }),
      result: JSON.stringify({
        mode,
        verdict: 'ready',
        blockers: 0,
        findings,
        unsure: 'u',
        next_step: 'approve',
        reasoning: 'r',
      }),
      created_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { own, chr, taskId, helpId: help.id }
}

const listed = async (taskId: string) =>
  (await app.inject({ url: `/api/tasks/${taskId}/helps` })).json()[0].result.findings
const file = (taskId: string, helpId: string, index: number) =>
  app.inject({ method: 'POST', url: `/api/tasks/${taskId}/helps/${helpId}/findings/${index}/file` })
const titled = (projectId: string, title: string) =>
  db()
    .selectFrom('tasks')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('title', '=', title)
    .execute()

describe('the outside findings of a review', () => {
  async function two() {
    const w = await world([
      outsideFinding('Same in own'),
      outsideFinding('Same in own', { project: 'CHR' }),
    ])
    await seedTask(db(), w.own.id, { title: 'same in own', number: 3, state: 'ready' })
    return w
  }

  it('looks each finding up in its own target project (AC7)', async () => {
    const w = await two()
    const findings = await listed(w.taskId)
    expect(findings[0].on_board).toMatchObject({ key: 'AIDP-3' })
    expect(findings[1].on_board).toBeNull()
  })

  it('files in the target project with a provenance line, and refuses a duplicate (AC7)', async () => {
    const w = await two()
    const duplicate = await file(w.taskId, w.helpId, 0)
    expect(duplicate.statusCode).toBe(409)
    expect(JSON.stringify(duplicate.json())).toContain('AIDP-3')
    expect(await titled(w.own.id, 'Same in own')).toHaveLength(0)

    const filed = await file(w.taskId, w.helpId, 1)
    expect(filed.statusCode).toBe(200)
    expect(filed.json()).toMatchObject({ key: 'CHR-1', state: 'backlog' })
    const tasks = await titled(w.chr.id, 'Same in own')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.state).toBe('backlog')
    expect(tasks[0]!.description_md).toMatch(
      new RegExp(`^${TEXT.replaceAll('*', '\\*')}\\n\\n.*Spec review of v1.*AIDP-12.*owner`),
    )
    expect((await listed(w.taskId))[1].on_board).toMatchObject({ key: 'CHR-1', state: 'backlog' })
    expect((await file(w.taskId, w.helpId, 1)).statusCode).toBe(409)
  })

  it('refuses a finding that is not outside and a help of another task (AC8)', async () => {
    const w = await world([
      { kind: 'missing', text: 'X', destination: 'blocker', evidence: 'R1' },
      outsideFinding('Elsewhere'),
    ])
    const other = await seedTask(db(), w.own.id, { number: 40 })
    const before = await db().selectFrom('tasks').select('id').execute()
    expect((await file(w.taskId, w.helpId, 0)).statusCode).toBe(409)
    expect((await file(w.taskId, w.helpId, 5)).statusCode).toBe(409)
    expect((await file(other.id, w.helpId, 1)).statusCode).toBe(409)
    await db().updateTable('helps').set({ status: 'failed' }).where('id', '=', w.helpId).execute()
    expect((await file(w.taskId, w.helpId, 1)).statusCode).toBe(409)
    expect(await db().selectFrom('tasks').select('id').execute()).toHaveLength(before.length)
  })
})
