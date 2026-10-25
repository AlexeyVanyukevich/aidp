import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { GOOD_SPEC, seedProject, seedQueuedRun, seedRunningRun, seedTask } from './fixtures.js'
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

// Slice 3: a spec drafted by the spec-writer, redrafted with a note, and a draft cancelled.
const describeAs = (taskId: string, description: string) =>
  db().updateTable('tasks').set({ description_md: description }).where('id', '=', taskId).execute()
const runsOf = (taskId: string) =>
  db()
    .selectFrom('runs')
    .select(['kind', 'number', 'spec_version', 'note', 'status', 'queued_at'])
    .where('task_id', '=', taskId)
    .orderBy('created_at')
    .execute()
const redraft = (taskId: string, payload?: Record<string, unknown>) => {
  const url = `/api/tasks/${taskId}/actions/redraft`
  return payload === undefined
    ? app.inject({ method: 'POST', url })
    : app.inject({ method: 'POST', url, payload })
}

/** A task in Spec review with two versions, as a first draft and a hand edit leave it. */
async function inReview() {
  const { id: projectId } = await seedProject(db())
  const { id: taskId } = await seedTask(db(), projectId, { state: 'spec_review' })
  await describeAs(taskId, 'Retry failed webhooks.')
  for (const version of [1, 2])
    await db()
      .insertInto('specs')
      .values({ task_id: taskId, version, body_md: GOOD_SPEC, status: 'draft', criteria: null })
      .execute()
  return taskId
}

/** A spec run in its Spec phase, the card in Spec draft, waiting on a question. */
async function pausedDraft(hasSpec: boolean) {
  const { id: projectId } = await seedProject(db())
  const { id: taskId } = await seedTask(db(), projectId, { state: 'spec_draft' })
  if (hasSpec)
    await db()
      .insertInto('specs')
      .values({ task_id: taskId, version: 1, body_md: GOOD_SPEC, status: 'draft', criteria: null })
      .execute()
  const { id: runId } = await db()
    .insertInto('runs')
    .values({
      task_id: taskId,
      kind: 'spec',
      number: 1,
      spec_version: hasSpec ? 1 : null,
      status: 'running',
      started_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const phaseId = crypto.randomUUID()
  await db()
    .insertInto('phases')
    .values({
      id: phaseId,
      run_id: runId,
      name: 'spec',
      attempt: 1,
      agent: 'spec-writer',
      model: 'opus',
      status: 'running',
      session_id: crypto.randomUUID(),
      started_at: new Date(),
    })
    .execute()
  const { id: approvalId } = await db()
    .transaction()
    .execute((trx) =>
      openApproval(
        trx,
        { runId, taskId, phaseId, kind: 'question', question: 'How often?', options: [] },
        new Date(),
        { recordEvent: true },
      ),
    )
  return { taskId, runId, approvalId }
}

describe('Draft spec', () => {
  it('queues a first draft from a Backlog card that has a description', async () => {
    const { id: projectId } = await seedProject(db())
    const { id: taskId } = await seedTask(db(), projectId)
    await describeAs(taskId, 'Retry failed webhooks.')
    const queued = app.bus.next('run.queued', 5_000)

    const response = await act(taskId, 'draft-spec')

    expect(response.statusCode).toBe(200)
    expect(response.json().state).toBe('spec_draft')
    const [first] = await runsOf(taskId)
    expect(first).toMatchObject({
      kind: 'spec',
      number: 1,
      spec_version: null,
      note: null,
      status: 'queued',
    })
    expect(first?.queued_at).not.toBeNull()
    expect(await queued).toMatchObject({ topic: 'run.queued' })
  })

  it('refuses an empty description, naming the field, and changes nothing', async () => {
    const { id: projectId } = await seedProject(db())
    const { id: taskId } = await seedTask(db(), projectId)
    await describeAs(taskId, '   ')
    const response = await act(taskId, 'draft-spec')
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: 'validation_error',
      details: { field: 'description_md' },
    })
    expect((await taskRow(taskId)).state).toBe('backlog')
    expect(await runsOf(taskId)).toEqual([])
  })

  it('refuses a card in Spec review, whose action is Redraft', async () => {
    expect((await act(await inReview(), 'draft-spec')).statusCode).toBe(409)
  })
})

describe('Redraft', () => {
  it('queues a draft of the latest version, carrying the owner’s note', async () => {
    const taskId = await inReview()
    const response = await redraft(taskId, { note: 'Say how long to wait.' })
    expect(response.statusCode).toBe(200)
    expect(response.json().state).toBe('spec_draft')
    expect(await runsOf(taskId)).toEqual([
      expect.objectContaining({
        kind: 'spec',
        number: 1,
        spec_version: 2,
        note: 'Say how long to wait.',
        status: 'queued',
      }),
    ])
  })

  it('refuses an empty note, naming the field', async () => {
    const response = await redraft(await inReview(), { note: '  ' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ details: { field: 'note' } })
  })

  it.each([
    ['no body', undefined],
    ['an unknown field', { note: 'x', urgent: true }],
    ['a note over 4 000 characters', { note: 'x'.repeat(4001) }],
  ])('refuses %s', async (_name, payload) => {
    expect((await redraft(await inReview(), payload)).statusCode).toBe(400)
  })

  it('refuses a card in Backlog', async () => {
    const { id: projectId } = await seedProject(db())
    const { id: taskId } = await seedTask(db(), projectId)
    expect((await redraft(taskId, { note: 'x' })).statusCode).toBe(409)
  })
})

describe('Cancel, on a draft', () => {
  it('returns a card whose first draft is still queued to Backlog', async () => {
    const { id: projectId } = await seedProject(db())
    const { id: taskId } = await seedTask(db(), projectId)
    await describeAs(taskId, 'Retry failed webhooks.')
    await act(taskId, 'draft-spec')

    expect((await act(taskId, 'cancel')).json().state).toBe('backlog')
    expect(await runsOf(taskId)).toEqual([expect.objectContaining({ status: 'cancelled' })])
  })

  it.each([
    [false, 'backlog'],
    [true, 'spec_review'],
  ])(
    'returns a draft waiting on a question, the task having a spec %s, to %s',
    async (hasSpec, state) => {
      const { taskId, runId, approvalId } = await pausedDraft(hasSpec)
      expect((await act(taskId, 'cancel')).json().state).toBe(state)
      expect(await run(runId)).toMatchObject({ status: 'cancelled', pending: 'cleanup' })
      const approval = await db()
        .selectFrom('approval_requests')
        .select('status')
        .where('id', '=', approvalId)
        .executeTakeFirstOrThrow()
      expect(approval.status).toBe('withdrawn')
    },
  )
})

// Slice 3 spec §5: a failed draft says why, until the next run; a batch says how many.
describe('what a card says about its draft', () => {
  const card = async (taskId: string) =>
    (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json()
  const endRun = (runId: string, status: 'failed' | 'cancelled', reason: string) =>
    db()
      .updateTable('runs')
      .set({ status, failure_reason: reason, ended_at: new Date() })
      .where('id', '=', runId)
      .execute()

  it('names why the latest draft failed', async () => {
    const { taskId, runId } = await pausedDraft(false)
    await endRun(runId, 'failed', 'the spec-writer saved no spec')
    expect((await card(taskId)).draft_failure).toBe('the spec-writer saved no spec')
  })

  it('says nothing of a draft the owner cancelled', async () => {
    const { taskId, runId } = await pausedDraft(false)
    await endRun(runId, 'cancelled', 'cancelled by the owner')
    expect((await card(taskId)).draft_failure).toBeNull()
  })

  it('says nothing once a later run has started', async () => {
    const { taskId, runId } = await pausedDraft(true)
    await endRun(runId, 'failed', 'the spec phase failed')
    await db()
      .insertInto('runs')
      .values({ task_id: taskId, kind: 'spec', number: 2, spec_version: 1, status: 'queued' })
      .execute()
    expect((await card(taskId)).draft_failure).toBeNull()
  })

  it('counts the questions of the batch it waits on', async () => {
    const seeded = await seedRunningRun(db())
    await db()
      .transaction()
      .execute((trx) =>
        openApproval(
          trx,
          {
            runId: seeded.runId,
            taskId: seeded.taskId,
            phaseId: seeded.phaseId,
            kind: 'questions',
            question: '',
            options: [],
            questions: [{ question: 'How often?' }, { question: 'Which?' }, { question: 'When?' }],
          },
          new Date(),
          { recordEvent: true },
        ),
      )
    expect((await card(seeded.taskId)).approval).toMatchObject({ kind: 'questions', questions: 3 })
  })
})
