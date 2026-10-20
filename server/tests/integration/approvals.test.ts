import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedRunningRun } from './fixtures.js'
import { openApproval, type OpenRequest } from '../../src/modules/approvals/approval.service.js'
import type { BoardMessage } from '../../src/shared/bus.js'

let app: FastifyInstance
const now = new Date('2026-10-20T10:00:00Z')
let heard: BoardMessage[] = []

beforeAll(async () => {
  app = await buildTestApp({ clock: () => now })
  app.bus.subscribe((message) => heard.push(message))
})
beforeEach(async () => {
  await resetDb()
  heard = []
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const db = () => getTestDb()
const A = { id: 'a', label: 'Red' }
const B = { id: 'b', label: 'Blue', impact: 'Matches the logo' }

async function open(change: Partial<OpenRequest> = {}) {
  const run = await seedRunningRun(db())
  const request: OpenRequest = {
    runId: run.runId,
    taskId: run.taskId,
    phaseId: run.phaseId,
    kind: 'question',
    question: 'Which colour?',
    options: [A, B],
    recommendation: 'b',
    context_md: 'The logo is blue.',
    files: null,
    ...change,
  }
  const opened = await db()
    .transaction()
    .execute((trx) => openApproval(trx, request, now, { recordEvent: true }))
  return { ...run, approvalId: opened.id, request }
}

/** Notices are delivered through PostgreSQL; this waits for the one a test expects. */
const notice = (topic: BoardMessage['topic']) => app.bus.next(topic, 2_000)
const answer = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/approvals/${id}/answer`, payload })
const row = (id: string) =>
  db().selectFrom('approval_requests').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
const runRow = (id: string) =>
  db().selectFrom('runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
const taskState = async (id: string) =>
  (await db().selectFrom('tasks').select('state').where('id', '=', id).executeTakeFirstOrThrow())
    .state

describe('opening an approval request', () => {
  it('pauses the phase, the run and the card, records the request, and says so', async () => {
    const requested = notice('approval.requested')
    const { approvalId, runId, taskId, phaseId, sessionId } = await open()

    expect(await row(approvalId)).toMatchObject({
      run_id: runId,
      phase_id: phaseId,
      kind: 'question',
      question: 'Which colour?',
      options: [A, B],
      recommendation: 'b',
      status: 'open',
      checkpoint: { phase: 'build', attempt: 1, session_id: sessionId },
    })
    const phase = await db()
      .selectFrom('phases')
      .select('status')
      .where('id', '=', phaseId)
      .executeTakeFirstOrThrow()
    expect(phase.status).toBe('paused')
    expect((await runRow(runId)).status).toBe('paused')
    expect(await taskState(taskId)).toBe('needs_approval')
    const events = await db()
      .selectFrom('events')
      .select(['type', 'phase_id', 'payload'])
      .where('run_id', '=', runId)
      .execute()
    expect(events).toEqual([
      {
        type: 'approval_requested',
        phase_id: phaseId,
        payload: { approval_id: approvalId, kind: 'question', question: 'Which colour?' },
      },
    ])
    expect(await requested).toEqual({ topic: 'approval.requested', taskId })
  })

  it('gives an out-of-plan request the server’s options, not the agent’s', async () => {
    const { approvalId } = await open({
      kind: 'out_of_plan',
      files: ['src/a.ts'],
      recommendation: null,
    })
    expect((await row(approvalId)).options).toEqual([
      { id: 'allow', label: 'Allow the change' },
      { id: 'refuse', label: 'Keep to the plan' },
    ])
  })

  it('refuses a second request while one is open', async () => {
    const first = await open()
    await expect(
      db()
        .transaction()
        .execute((trx) => openApproval(trx, first.request, now, { recordEvent: true })),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('opens a replayed request once', async () => {
    const id = '00000000-0000-4000-8000-0000000000aa'
    const first = await open({ id })
    const again = await db()
      .transaction()
      .execute((trx) => openApproval(trx, first.request, now, { recordEvent: true }))
    expect(again).toEqual({ id, opened: false })
    const count = await db()
      .selectFrom('approval_requests')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow()
    expect(Number(count.n)).toBe(1)
  })

  it('refuses a request whose recommendation names no option, with the finding', async () => {
    await expect(open({ recommendation: 'z' })).rejects.toMatchObject({
      code: 'validation_error',
      details: { findings: [{ field: 'recommendation', code: 'unknown_option' }] },
    })
  })
})

describe('POST /api/approvals/:id/answer', () => {
  it.each([
    { name: 'an option', body: { option_id: 'b' } },
    { name: 'words', body: { text: 'Use the logo blue' } },
  ])('answers with $name: the card runs again and a resume is queued', async ({ body }) => {
    const { approvalId, runId, taskId } = await open()
    const queued = notice('run.queued')
    const answered = notice('approval.answered')

    const response = await answer(approvalId, body)

    expect(response.statusCode).toBe(200)
    expect(await row(approvalId)).toMatchObject({
      status: 'answered',
      answer: body,
      answered_at: now,
    })
    expect(await taskState(taskId)).toBe('running')
    const run = await runRow(runId)
    expect(run).toMatchObject({ status: 'queued', pending: 'resume', queued_at: now })
    expect(run.resume_message).toMatch(/^The owner answered your question:/)
    expect(await answered).toEqual({ topic: 'approval.answered', taskId })
    expect(await queued).toEqual({ topic: 'run.queued', runId })
    const events = await db()
      .selectFrom('events')
      .select('type')
      .where('run_id', '=', runId)
      // Both carry the test's frozen clock; the database's arrival time orders them.
      .orderBy('received_at')
      .execute()
    expect(events.map((e) => e.type)).toEqual(['approval_requested', 'approval_answered'])
  })

  it.each([
    { name: 'neither an option nor words', body: {}, field: 'text' },
    { name: 'an option it does not offer', body: { option_id: 'zz' }, field: 'option_id' },
  ])('refuses $name, naming the field', async ({ body, field }) => {
    const { approvalId } = await open()
    const response = await answer(approvalId, body)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'validation_error', details: { field } })
  })

  it('refuses a field it does not know', async () => {
    const { approvalId } = await open()
    expect((await answer(approvalId, { text: 'x', extra: 1 })).statusCode).toBe(400)
  })

  it.each(['answered', 'withdrawn'] as const)('refuses an approval %s as stale', async (status) => {
    const { approvalId } = await open()
    await db()
      .updateTable('approval_requests')
      .set({ status })
      .where('id', '=', approvalId)
      .execute()
    expect((await answer(approvalId, { text: 'again' })).statusCode).toBe(409)
  })

  async function expired(taskStillBlocked: boolean) {
    const opened = await open()
    await db()
      .updateTable('approval_requests')
      .set({ status: 'expired' })
      .where('id', '=', opened.approvalId)
      .execute()
    await db()
      .updateTable('runs')
      .set({
        status: 'blocked',
        block: JSON.stringify({ cause: 'approval_expired', stage: 'build' }),
      })
      .where('id', '=', opened.runId)
      .execute()
    await db()
      .updateTable('tasks')
      .set({ state: taskStillBlocked ? 'blocked' : 'failed' })
      .where('id', '=', opened.taskId)
      .execute()
    return opened
  }

  it('answers an expired question on a card it blocked, and the run resumes', async () => {
    const { approvalId, runId, taskId } = await expired(true)
    expect((await answer(approvalId, { option_id: 'a' })).statusCode).toBe(200)
    expect(await taskState(taskId)).toBe('running')
    expect(await runRow(runId)).toMatchObject({ status: 'queued', pending: 'resume', block: null })
  })

  it('refuses an expired question once its card has moved on', async () => {
    const { approvalId } = await expired(false)
    expect((await answer(approvalId, { option_id: 'a' })).statusCode).toBe(409)
  })

  it('approves a plan: a resume with no message, since Build starts afresh', async () => {
    const { approvalId, runId } = await open({ kind: 'plan', options: [], recommendation: null })
    expect((await answer(approvalId, { option_id: 'approve' })).statusCode).toBe(200)
    expect(await runRow(runId)).toMatchObject({ pending: 'resume', resume_message: null })
  })

  it('answers 404 for an approval that does not exist', async () => {
    expect((await answer('00000000-0000-4000-8000-0000000000ff', { text: 'x' })).statusCode).toBe(
      404,
    )
  })
})

describe('listing approvals', () => {
  it('lists a task’s approvals, newest first', async () => {
    const { approvalId, taskId } = await open()
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/approvals` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: approvalId,
        kind: 'question',
        question: 'Which colour?',
        options: [A, B],
        recommendation: 'b',
        context_md: 'The logo is blue.',
        files: null,
        status: 'open',
        answer: null,
      }),
    ])
  })

  it('lists the open ones across projects, oldest first, with their task and project', async () => {
    const first = await open()
    const second = await seedRunningRun(db(), { projectKey: 'OPS' })
    await db()
      .transaction()
      .execute((trx) =>
        openApproval(
          trx,
          { ...first.request, runId: second.runId, taskId: second.taskId, phaseId: second.phaseId },
          new Date(now.getTime() + 1_000),
          { recordEvent: true },
        ),
      )
    const response = await app.inject({ method: 'GET', url: '/api/approvals?status=open' })
    expect(
      response.json().map((a: { task_key: string; project_key: string }) => a.task_key),
    ).toEqual(['PAY-1', 'OPS-1'])
    expect(response.json()[1]).toMatchObject({ project_key: 'OPS', task_id: second.taskId })
  })

  it('refuses a status it does not list', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/approvals?status=answered' })).statusCode,
    ).toBe(400)
  })
})
