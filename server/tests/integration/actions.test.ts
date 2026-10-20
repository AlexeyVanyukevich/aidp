import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedQueuedRun, seedRunningRun } from './fixtures.js'
import { openApproval } from '../../src/modules/approvals/approval.service.js'
import type { BlockCause } from '../../src/shared/vocabulary.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const act = (taskId: string, action: string) =>
  app.inject({ method: 'POST', url: `/api/tasks/${taskId}/actions/${action}` })
const run = (runId: string) =>
  getTestDb().selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow()

describe('Cancel', () => {
  it('cancels a queued run outright', async () => {
    const { taskId, runId } = await seedQueuedRun(getTestDb())
    expect((await act(taskId, 'cancel')).json().state).toBe('failed')
    expect(await run(runId)).toMatchObject({
      status: 'cancelled',
      failure_reason: 'cancelled by the owner',
    })
  })

  it('asks the runner to stop a running run', async () => {
    const { taskId, runId } = await seedQueuedRun(getTestDb())
    await getTestDb()
      .updateTable('runs')
      .set({ status: 'running' })
      .where('id', '=', runId)
      .execute()
    await getTestDb()
      .updateTable('tasks')
      .set({ state: 'running' })
      .where('id', '=', taskId)
      .execute()
    expect((await act(taskId, 'cancel')).json().state).toBe('failed')
    expect(await run(runId)).toMatchObject({ status: 'running', cancel_requested: true })
  })

  it('answers 409 for a card with nothing to cancel', async () => {
    const { taskId } = await seedQueuedRun(getTestDb(), { state: 'review' })
    expect((await act(taskId, 'cancel')).statusCode).toBe(409)
  })
})

describe('Re-run', () => {
  it('queues a new delivery run of the approved spec', async () => {
    const { taskId } = await seedQueuedRun(getTestDb(), { state: 'failed' })
    expect((await act(taskId, 'rerun')).json().state).toBe('ready')
    const runs = await getTestDb()
      .selectFrom('runs')
      .select(['status', 'spec_version'])
      .where('task_id', '=', taskId)
      .orderBy('created_at')
      .execute()
    expect(runs).toEqual([
      { status: 'queued', spec_version: 1 },
      { status: 'queued', spec_version: 1 },
    ])
  })

  it('refuses an unknown action', async () => {
    const { taskId } = await seedQueuedRun(getTestDb())
    expect((await act(taskId, 'deploy')).statusCode).toBe(400)
  })
})

const db = () => getTestDb()
const taskRow = (id: string) =>
  db().selectFrom('tasks').select('state').where('id', '=', id).executeTakeFirstOrThrow()

/** A run blocked for `cause`, with the checkpoint its runner left. */
async function blocked(
  cause: BlockCause,
  checkpoint = true,
  where: { projectId?: string; number?: number } = {},
) {
  const seeded = await seedRunningRun(db(), where)
  await db()
    .updateTable('runs')
    .set({
      status: 'blocked',
      block: JSON.stringify({ cause, stage: 'build' }),
      checkpoint: checkpoint
        ? JSON.stringify({
            stage: 'build',
            attempt: 1,
            phase_id: seeded.phaseId,
            session: { id: seeded.sessionId, baseline: {}, reported: {} },
            head: null,
            plan_artifact_id: null,
            failing_report_id: null,
          })
        : null,
    })
    .where('id', '=', seeded.runId)
    .execute()
  await db()
    .updateTable('tasks')
    .set({ state: 'blocked' })
    .where('id', '=', seeded.taskId)
    .execute()
  return seeded
}

async function paused(where: { projectId?: string; number?: number } = {}) {
  const seeded = await seedRunningRun(db(), where)
  const { id } = await db()
    .transaction()
    .execute((trx) =>
      openApproval(
        trx,
        {
          runId: seeded.runId,
          taskId: seeded.taskId,
          phaseId: seeded.phaseId,
          kind: 'question',
          question: 'Which colour?',
          options: [{ id: 'a', label: 'Red' }],
        },
        new Date(),
        { recordEvent: true },
      ),
    )
  return { ...seeded, approvalId: id }
}

describe('Resume', () => {
  it.each(['runner_lost', 'step_failed', 'runner_stopped'] as const)(
    'queues a resume of a run blocked by %s, and the card runs again',
    async (cause) => {
      const { taskId, runId } = await blocked(cause)
      const response = await act(taskId, 'resume')
      expect(response.statusCode).toBe(200)
      expect(response.json().state).toBe('running')
      expect(await run(runId)).toMatchObject({
        status: 'queued',
        pending: 'resume',
        resume_message: 'You were interrupted. Continue from where you stopped.',
        block: null,
      })
      expect((await run(runId)).queued_at).not.toBeNull()
    },
  )

  it('refuses a card blocked by an unanswered question: answering it resumes the run', async () => {
    const { taskId } = await blocked('approval_expired')
    expect((await act(taskId, 'resume')).statusCode).toBe(409)
  })

  it('refuses a run with no checkpoint to resume from', async () => {
    const { taskId } = await blocked('runner_lost', false)
    expect((await act(taskId, 'resume')).statusCode).toBe(409)
  })

  it('refuses a card that is not blocked', async () => {
    const { taskId } = await seedRunningRun(db())
    expect((await act(taskId, 'resume')).statusCode).toBe(409)
  })
})

describe('Cancel, on a paused or blocked card', () => {
  it('fails a card waiting on a question, withdraws it, and queues the worktree’s cleanup', async () => {
    const { taskId, runId, approvalId } = await paused()
    expect((await act(taskId, 'cancel')).json().state).toBe('failed')
    expect(await run(runId)).toMatchObject({
      status: 'cancelled',
      pending: 'cleanup',
      failure_reason: 'cancelled by the owner',
    })
    expect((await run(runId)).queued_at).not.toBeNull()
    const approval = await db()
      .selectFrom('approval_requests')
      .select('status')
      .where('id', '=', approvalId)
      .executeTakeFirstOrThrow()
    expect(approval.status).toBe('withdrawn')
  })

  it('fails a blocked card and queues the worktree’s cleanup', async () => {
    const { taskId, runId } = await blocked('step_failed')
    expect((await act(taskId, 'cancel')).json().state).toBe('failed')
    expect(await run(runId)).toMatchObject({ status: 'cancelled', pending: 'cleanup' })
  })
})

describe('what a card says about a pause or a block', () => {
  it('names the question a paused card waits on', async () => {
    const { taskId, approvalId } = await paused()
    const task = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json()
    expect(task).toMatchObject({
      state: 'needs_approval',
      approval: { id: approvalId, kind: 'question', status: 'open' },
      block: null,
    })
  })

  it('says why a blocked card is blocked', async () => {
    const { taskId } = await blocked('step_failed')
    const task = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json()
    expect(task).toMatchObject({ approval: null, block: { cause: 'step_failed', stage: 'build' } })
  })

  it('marks the board’s cards that wait on a question, an expired one included', async () => {
    const waiting = await paused()
    const expired = await paused({ projectId: waiting.projectId, number: 2 })
    await db()
      .updateTable('approval_requests')
      .set({ status: 'expired' })
      .where('id', '=', expired.approvalId)
      .execute()
    await db()
      .updateTable('runs')
      .set({
        status: 'blocked',
        block: JSON.stringify({ cause: 'approval_expired', stage: 'build' }),
      })
      .where('id', '=', expired.runId)
      .execute()
    await db()
      .updateTable('tasks')
      .set({ state: 'blocked' })
      .where('id', '=', expired.taskId)
      .execute()
    const quiet = await blocked('runner_lost', true, { projectId: waiting.projectId, number: 3 })
    const board = (await app.inject({ method: 'GET', url: '/api/projects/PAY/tasks' })).json()
    const flag = (id: string) =>
      board.tasks.find((t: { id: string; question_waiting: boolean }) => t.id === id)
        ?.question_waiting
    expect([flag(waiting.taskId), flag(expired.taskId), flag(quiet.taskId)]).toEqual([
      true,
      true,
      false,
    ])
  })

  it('shows an interrupted phase on the run', async () => {
    const { taskId, phaseId } = await seedRunningRun(db())
    await db().updateTable('phases').set({ interrupted: true }).where('id', '=', phaseId).execute()
    const runs = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/runs` })).json()
    expect(runs[0].phases[0]).toMatchObject({ id: phaseId, interrupted: true })
  })
})
