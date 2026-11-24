import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'
import {
  GOOD_SPEC,
  seedProject,
  seedQueuedRun,
  seedRunningRun,
  seedTask,
  seedTitleRun,
} from './fixtures.js'
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

  describe('keeping the plan', () => {
    const PLAN_DATA = {
      confidence: 'high',
      steps: [{ title: 's', requirements: ['R1'], files: ['a.ts'] }],
    }
    const rerun = (taskId: string, payload?: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/actions/rerun`,
        ...(payload === undefined ? {} : { payload: payload as object }),
      })
    async function failedWithPlan(confidence: 'high' | 'medium') {
      const seeded = await seedQueuedRun(getTestDb(), { state: 'failed' })
      await getTestDb()
        .updateTable('runs')
        .set({ status: 'failed', queued_at: null })
        .where('id', '=', seeded.runId)
        .execute()
      const planned = await getTestDb()
        .insertInto('artifacts')
        .values({
          run_id: seeded.runId,
          phase_id: null,
          kind: 'plan',
          body_md: 'the plan',
          data: JSON.stringify({ ...PLAN_DATA, confidence }),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return { ...seeded, artifactId: planned.id }
    }
    const artifactsOf = (runId: string) =>
      getTestDb().selectFrom('artifacts').selectAll().where('run_id', '=', runId).execute()

    it('copies the accepted plan into the new run and leaves the old one alone', async () => {
      const { taskId, runId, artifactId } = await failedWithPlan('high')
      const view = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })
      expect(view.json().plan_to_keep).toEqual({ run: 1 })
      const response = await rerun(taskId, { plan: 'keep' })
      expect(response.json().state).toBe('ready')
      const fresh = await getTestDb()
        .selectFrom('runs')
        .select(['id', 'status'])
        .where('id', '!=', runId)
        .executeTakeFirstOrThrow()
      expect(fresh.status).toBe('queued')
      const copied = await artifactsOf(fresh.id)
      expect(copied).toMatchObject([
        { kind: 'plan', body_md: 'the plan', data: PLAN_DATA, copied_from_run: 1 },
      ])
      expect(await artifactsOf(runId)).toMatchObject([
        { id: artifactId, copied_from_run: null, body_md: 'the plan' },
      ])
    })

    it('answers 409 and moves nothing when there is no plan to keep', async () => {
      const { taskId } = await failedWithPlan('medium')
      const response = await rerun(taskId, { plan: 'keep' })
      expect(response.statusCode).toBe(409)
      expect(response.json().error).toBe('conflict')
      expect(
        (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json(),
      ).toMatchObject({
        state: 'failed',
        plan_to_keep: null,
      })
      expect(
        await getTestDb().selectFrom('runs').select('id').where('task_id', '=', taskId).execute(),
      ).toHaveLength(1)
    })

    it('plans again without a body, or with "again"', async () => {
      const { taskId } = await failedWithPlan('high')
      expect((await rerun(taskId, { plan: 'again' })).json().state).toBe('ready')
      const fresh = await getTestDb()
        .selectFrom('runs')
        .select('id')
        .where('task_id', '=', taskId)
        .where('number', '=', 2)
        .executeTakeFirstOrThrow()
      expect(await artifactsOf(fresh.id)).toEqual([])
    })

    it.each([
      ['an unknown field', { plan: 'again', note: 'x', extra: 1 }, 'extra'],
      ['a note of 4001 characters', { note: 'n'.repeat(4_001) }, 'note'],
    ])('refuses %s with 400 naming the field', async (_name, payload, field) => {
      const { taskId } = await failedWithPlan('high')
      const response = await rerun(taskId, payload)
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('validation_error')
      expect(JSON.stringify(response.json().details)).toContain(field)
    })

    const noteOf = async (taskId: string) =>
      (
        await getTestDb()
          .selectFrom('runs')
          .select('note')
          .where('task_id', '=', taskId)
          .where('number', '=', 2)
          .executeTakeFirstOrThrow()
      ).note

    it.each([
      ['no body', undefined, null],
      ['a blank note', { note: '   ' }, null],
      [
        'a note with spaces round it',
        { plan: 'keep', note: ' keep tests in tests/unit ' },
        'keep tests in tests/unit',
      ],
    ])('stores the note for %s trimmed, or null', async (_name, payload, stored) => {
      const { taskId } = await failedWithPlan('high')
      expect((await rerun(taskId, payload)).statusCode).toBe(200)
      expect(await noteOf(taskId)).toBe(stored)
    })

    it('refuses another value with 400 naming plan', async () => {
      const { taskId } = await failedWithPlan('high')
      const response = await rerun(taskId, { plan: 'later' })
      expect(response.statusCode).toBe(400)
      expect(response.json().details).toEqual({ field: 'plan' })
      expect(response.json().error).toBe('validation_error')
    })
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

const post = (taskId: string, action: string, payload?: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/actions/${action}`,
    payload: payload as never,
  })
const titleRuns = (taskId: string) =>
  getTestDb()
    .selectFrom('runs')
    .selectAll()
    .where('task_id', '=', taskId)
    .where('kind', '=', 'title')
    .execute()
const task = (taskId: string) =>
  getTestDb().selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirstOrThrow()

describe('Rephrase title', () => {
  it.each(['backlog', 'spec_review'] as const)(
    'queues a title run in %s and leaves the card',
    async (state) => {
      const { id } = await seedTask(getTestDb(), (await seedProject(getTestDb())).id, { state })
      const response = await post(id, 'rephrase-title')
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ state, title_suggestion: { status: 'working' } })
      expect(await titleRuns(id)).toMatchObject([{ status: 'queued', number: 1 }])
      expect((await post(id, 'rephrase-title')).statusCode).toBe(409)
      expect(await titleRuns(id)).toHaveLength(1)
    },
  )

  it('answers 409 in Ready and creates no run', async () => {
    const { taskId } = await seedQueuedRun(getTestDb())
    expect((await post(taskId, 'rephrase-title')).statusCode).toBe(409)
    expect(await titleRuns(taskId)).toEqual([])
  })

  it('numbers a second suggestion among the title runs', async () => {
    const { id } = await seedTask(getTestDb(), (await seedProject(getTestDb())).id)
    await seedTitleRun(getTestDb(), id, { status: 'cancelled' })
    await post(id, 'rephrase-title')
    expect((await titleRuns(id)).map((r) => r.number).sort()).toEqual([1, 2])
  })
})

describe('Stop title', () => {
  it('cancels a queued run at once', async () => {
    const { id } = await seedTask(getTestDb(), (await seedProject(getTestDb())).id)
    await post(id, 'rephrase-title')
    const response = await post(id, 'stop-title')
    expect(response.json()).toMatchObject({ state: 'backlog', title_suggestion: null })
    expect(await titleRuns(id)).toMatchObject([{ status: 'cancelled' }])
  })

  it('asks the runner to stop a running one', async () => {
    const { id } = await seedTask(getTestDb(), (await seedProject(getTestDb())).id)
    await seedTitleRun(getTestDb(), id, { status: 'running' })
    expect((await post(id, 'stop-title')).statusCode).toBe(200)
    expect(await titleRuns(id)).toMatchObject([{ status: 'running', cancel_requested: true }])
  })

  it('answers 409 with none', async () => {
    const { id } = await seedTask(getTestDb(), (await seedProject(getTestDb())).id)
    expect((await post(id, 'stop-title')).statusCode).toBe(409)
  })
})

describe('Accept and discard title', () => {
  async function ready() {
    const { id } = await seedTask(getTestDb(), (await seedProject(getTestDb())).id)
    const runId = await seedTitleRun(getTestDb(), id, {
      status: 'succeeded',
      suggestion: { title: "Rename drop_draft's destination", reason: 'names drop_draft' },
    })
    return { id, runId }
  }
  const decision = async (runId: string) =>
    (
      await getTestDb()
        .selectFrom('artifacts')
        .select('data')
        .where('run_id', '=', runId)
        .executeTakeFirstOrThrow()
    ).data as { decision: string | null }

  it('sets the edited text as the title', async () => {
    const { id, runId } = await ready()
    const response = await post(id, 'accept-title', { title: 'Rename drop_draft destination' })
    expect(response.json()).toMatchObject({
      title: 'Rename drop_draft destination',
      title_suggestion: null,
    })
    expect((await decision(runId)).decision).toBe('accepted')
  })

  it('discards and leaves the title', async () => {
    const { id, runId } = await ready()
    const response = await post(id, 'discard-title')
    expect(response.json()).toMatchObject({ title: 'Retry webhooks', title_suggestion: null })
    expect((await decision(runId)).decision).toBe('discarded')
    expect((await post(id, 'discard-title')).statusCode).toBe(409)
  })

  it('answers 409 with no ready suggestion', async () => {
    const { id } = await seedTask(getTestDb(), (await seedProject(getTestDb())).id)
    expect((await post(id, 'accept-title', { title: 'X' })).statusCode).toBe(409)
    expect((await post(id, 'discard-title')).statusCode).toBe(409)
  })

  it('answers 409 outside Backlog and Spec review', async () => {
    const { id } = await ready()
    await getTestDb().updateTable('tasks').set({ state: 'ready' }).where('id', '=', id).execute()
    expect((await post(id, 'accept-title', { title: 'X' })).statusCode).toBe(409)
    expect((await task(id)).title).toBe('Retry webhooks')
  })

  it('refuses a blank title naming the field', async () => {
    const { id } = await ready()
    const response = await post(id, 'accept-title', { title: '  ' })
    expect(response.statusCode).toBe(400)
    expect(response.json().details).toMatchObject({ field: 'title' })
  })
})

describe('Cancel with a title run', () => {
  it('chooses the delivery run, not the later title run', async () => {
    const { taskId, runId } = await seedQueuedRun(getTestDb())
    await seedTitleRun(getTestDb(), taskId, { status: 'queued' })
    await act(taskId, 'cancel')
    expect(await run(runId)).toMatchObject({ status: 'cancelled' })
    expect(await titleRuns(taskId)).toMatchObject([{ status: 'queued' }])
  })
})

describe('Send back (AIDP-59)', () => {
  const PLAN = {
    confidence: 'high',
    steps: [{ title: 's', requirements: ['R1'], files: ['a.ts'] }],
  }
  const sendBack = (taskId: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/actions/send-back`,
      payload: payload as object,
    })
  const auth = { authorization: `Bearer ${TEST_RUNNER_KEY}` }
  const stateOf = async (taskId: string) =>
    (
      await db()
        .selectFrom('tasks')
        .select('state')
        .where('id', '=', taskId)
        .executeTakeFirstOrThrow()
    ).state
  const deliveries = (taskId: string) =>
    db()
      .selectFrom('runs')
      .selectAll()
      .where('task_id', '=', taskId)
      .where('kind', '=', 'delivery')
      .orderBy('number')
      .execute()

  /** A card in Review whose run 1 holds pull request 7, a plan, an allowance and a migration. */
  async function reviewed(options: { pr?: boolean; state?: 'review' | 'failed' } = {}) {
    const seeded = await seedQueuedRun(db(), { state: options.state ?? 'review' })
    await db()
      .updateTable('runs')
      .set({
        status: 'succeeded',
        queued_at: null,
        branch: 'board/PAY-1-r1',
        ...(options.pr === false
          ? {}
          : { pr_number: 7, pr_url: 'https://github.com/owner/pay/pull/7' }),
      })
      .where('id', '=', seeded.runId)
      .execute()
    await db()
      .insertInto('artifacts')
      .values({
        run_id: seeded.runId,
        phase_id: null,
        kind: 'plan',
        body_md: 'the plan',
        data: JSON.stringify(PLAN),
      })
      .execute()
    const answered = (kind: 'out_of_plan' | 'migration', files: string[], content: string | null) =>
      db()
        .insertInto('approval_requests')
        .values({
          run_id: seeded.runId,
          kind,
          question: 'q',
          options: JSON.stringify([]),
          context_md: content,
          status: 'answered',
          answer: JSON.stringify({ option_id: 'allow' }),
          files: JSON.stringify(files),
          answered_at: new Date(),
        })
        .execute()
    await answered('out_of_plan', ['b.ts'], null)
    await answered('migration', ['m/018.ts'], 'the migration')
    return seeded
  }

  async function claimRun(): Promise<{
    kind: string
    run: { id: string; number: number; kept_plan: unknown; continues: unknown; note: string }
    allowed_files?: string[]
    approved_migrations?: unknown[]
  }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/runner/claim',
      headers: auth,
      payload: { runner_id: 'r1', wait_ms: 0 },
    })
    return response.json().work
  }

  it('moves to Ready and queues run 2 tied to run 1 (AC2)', async () => {
    const { taskId, runId } = await reviewed()
    const response = await sendBack(taskId, { note: '  fix the comment  ' })
    expect(response.statusCode).toBe(200)
    expect(await stateOf(taskId)).toBe('ready')
    const [, second] = await deliveries(taskId)
    expect(second).toMatchObject({
      number: 2,
      status: 'queued',
      note: 'fix the comment',
      branch: 'board/PAY-1-r1',
      pr_number: 7,
      pr_url: 'https://github.com/owner/pay/pull/7',
      continues_run: 1,
    })
    const listing = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/runs` })
    expect(listing.json().find((r: { number: number }) => r.number === 2)).toMatchObject({
      continues_run: 1,
    })
    expect(runId).not.toBe(second!.id)
  })

  it.each([
    ['an empty body', {}, 'note'],
    ['a blank note', { note: '   ' }, 'note'],
    ['a note of 4001 characters', { note: 'n'.repeat(4_001) }, 'note'],
    ['an unknown field', { note: 'x', extra: 1 }, 'extra'],
  ])('refuses %s with 400 naming the field (AC3)', async (_name, payload, field) => {
    const { taskId } = await reviewed()
    const response = await sendBack(taskId, payload)
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
    expect(JSON.stringify(response.json())).toContain(field)
    expect(await deliveries(taskId)).toHaveLength(1)
  })

  it('answers 409 and queues nothing from Failed or with no pull request (AC3)', async () => {
    const failed = await reviewed({ state: 'failed' })
    expect((await sendBack(failed.taskId, { note: 'x' })).statusCode).toBe(409)
    expect(await deliveries(failed.taskId)).toHaveLength(1)
    await resetDb()
    const bare = await reviewed({ pr: false })
    expect((await sendBack(bare.taskId, { note: 'x' })).statusCode).toBe(409)
    expect(await stateOf(bare.taskId)).toBe('review')
    expect(await deliveries(bare.taskId)).toHaveLength(1)
  })

  describe('with a help (AC4)', () => {
    async function withHelps(newestStep: string) {
      const seeded = await reviewed()
      const add = async (step: string, at: string) => {
        const helpRun = await db()
          .insertInto('runs')
          .values({
            task_id: seeded.taskId,
            kind: 'help',
            number: Math.floor(Math.random() * 1e6),
            status: 'succeeded',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        return (
          await db()
            .insertInto('helps')
            .values({
              run_id: helpRun.id,
              decision: 'pull_request',
              mode: 'code_review',
              status: 'succeeded',
              subject: JSON.stringify({ pr_run_id: seeded.runId }),
              result: JSON.stringify({
                mode: 'code_review',
                verdict: 'changes',
                blockers: 1,
                findings: [],
                next_step: step,
                reasoning: 'r',
                unsure: 'u',
                commit: 'abc',
                skipped: [],
              }),
              created_at: new Date(at),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id
      }
      const older = await add('fix_by_hand', '2026-11-20T09:00:00Z')
      const newest = await add(newestStep, '2026-11-20T10:00:00Z')
      return { ...seeded, older, newest }
    }

    it('queues for the standing fix_by_hand help', async () => {
      const w = await withHelps('fix_by_hand')
      expect((await sendBack(w.taskId, { note: 'x', help_id: w.newest })).statusCode).toBe(200)
      expect(await stateOf(w.taskId)).toBe('ready')
      expect(await deliveries(w.taskId)).toHaveLength(2)
    })

    it('refuses an older help and a help whose step is not fix_by_hand', async () => {
      const w = await withHelps('fix_by_hand')
      expect((await sendBack(w.taskId, { note: 'x', help_id: w.older })).statusCode).toBe(409)
      expect(await stateOf(w.taskId)).toBe('review')
      await resetDb()
      const merge = await withHelps('merge')
      expect((await sendBack(merge.taskId, { note: 'x', help_id: merge.newest })).statusCode).toBe(
        409,
      )
      expect(await stateOf(merge.taskId)).toBe('review')
      expect(await deliveries(merge.taskId)).toHaveLength(1)
    })
  })

  it('copies the plan and hands the claim the inherited lists, through the chain (AC5)', async () => {
    const { taskId, runId } = await reviewed()
    await sendBack(taskId, { note: 'one' })
    const second = await claimRun()
    expect(second.run).toMatchObject({ number: 2, note: 'one' })
    expect(second.run.continues).toMatchObject({ run: 1, branch: 'board/PAY-1-r1', pr_number: 7 })
    expect(second.run.kept_plan).toMatchObject({ from_run: 1 })
    expect(second.allowed_files).toEqual(['a.ts', 'b.ts', 'm/018.ts'])
    expect(second.approved_migrations).toEqual([{ path: 'm/018.ts', content: 'the migration' }])
    const plan = await db()
      .selectFrom('artifacts')
      .selectAll()
      .where('run_id', '=', second.run.id)
      .where('kind', '=', 'plan')
      .executeTakeFirstOrThrow()
    expect(plan).toMatchObject({ copied_from_run: 1, body_md: 'the plan', data: PLAN })
    expect(runId).not.toBe(second.run.id)

    // Run 2 ends in Review, and is sent back in turn.
    await db()
      .updateTable('runs')
      .set({ status: 'succeeded' })
      .where('id', '=', second.run.id)
      .execute()
    await db().updateTable('tasks').set({ state: 'review' }).where('id', '=', taskId).execute()
    await sendBack(taskId, { note: 'two' })
    const third = await claimRun()
    expect(third.run).toMatchObject({ number: 3 })
    expect(third.run.continues).toMatchObject({ run: 2 })
    expect(third.allowed_files).toEqual(['a.ts', 'b.ts', 'm/018.ts'])
    expect(third.approved_migrations).toEqual([{ path: 'm/018.ts', content: 'the migration' }])
  })

  describe('the end of a continuing run (AC19)', () => {
    async function continuing() {
      const w = await reviewed()
      await sendBack(w.taskId, { note: 'x' })
      return w
    }
    const end = async (runId: string, payload: Record<string, unknown>) => {
      const token = (
        await app.inject({ method: 'POST', url: `/api/runner/runs/${runId}/tokens`, headers: auth })
      ).json().token as string
      return app.inject({
        method: 'POST',
        url: '/api/runner/events',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          events: [
            {
              id: crypto.randomUUID(),
              run_id: runId,
              phase_id: null,
              ts: new Date().toISOString(),
              type: 'run_end',
              agent: null,
              model: null,
              tool: null,
              target: null,
              status: null,
              duration_ms: null,
              usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
              payload,
            },
          ],
        },
      })
    }

    it('returns the card to Review, keeping the pull request, when the run fails', async () => {
      const w = await continuing()
      const work = await claimRun()
      expect(await stateOf(w.taskId)).toBe('running')
      await end(work.run.id, { outcome: 'failed', reason: 'verify failed' })
      expect(await stateOf(w.taskId)).toBe('review')
      const latest = (await deliveries(w.taskId)).at(-1)!
      expect(latest).toMatchObject({ status: 'failed', pr_number: 7, branch: 'board/PAY-1-r1' })
      expect((await sendBack(w.taskId, { note: 'again' })).statusCode).toBe(200)
    })

    it.each(['ready', 'blocked'] as const)(
      'returns the card to Review on Cancel from %s',
      async (from) => {
        const w = await continuing()
        if (from === 'blocked') {
          await claimRun()
          await db()
            .updateTable('runs')
            .set({
              status: 'blocked',
              block: JSON.stringify({ cause: 'step_failed', stage: 'build' }),
            })
            .where('task_id', '=', w.taskId)
            .where('number', '=', 2)
            .execute()
          await db()
            .updateTable('tasks')
            .set({ state: 'blocked' })
            .where('id', '=', w.taskId)
            .execute()
        }
        expect((await act(w.taskId, 'cancel')).json().state).toBe('review')
      },
    )

    it('moves the card to Failed when the run ends because its pull request merged', async () => {
      const w = await continuing()
      const work = await claimRun()
      await end(work.run.id, {
        outcome: 'failed',
        reason:
          'pull request #7 was merged on GitHub while the changes were being made; nothing was pushed',
        pr_state: 'MERGED',
      })
      expect(await stateOf(w.taskId)).toBe('failed')
    })
  })
})
