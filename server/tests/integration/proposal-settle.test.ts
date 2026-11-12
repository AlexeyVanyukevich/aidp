import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { ProposalService } from '../../src/modules/proposals/proposal.service.js'
import { Sweeper } from '../../src/modules/runs/sweeper.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { addTask, propose, relatedWorld, world } from './proposal-world.js'

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

const settle = (taskId: string, proposalId: string, body: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/proposals/${proposalId}/settle`,
    payload: body as object,
  })
const act = (taskId: string, action: string) =>
  app.inject({ method: 'POST', url: `/api/tasks/${taskId}/actions/${action}` })
const taskRow = (id: string) =>
  db().selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
const runRow = (id: string) =>
  db().selectFrom('runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
const proposalRow = (id: string) =>
  db().selectFrom('proposals').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
const approvalOf = (runId: string) =>
  db()
    .selectFrom('approval_requests')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()

async function unrelated(title = 'Radio cannot be unticked') {
  const w = await world()
  expect((await propose(w, { title, bearing_md: 'seen in build' })).isError).toBe(false)
  const row = await db()
    .selectFrom('proposals')
    .select('id')
    .where('run_id', '=', w.runId)
    .executeTakeFirstOrThrow()
  return { ...w, proposalId: row.id }
}

describe('settling an unrelated proposal', () => {
  it('files a task at the bottom of Backlog, after the commit (AC17)', async () => {
    const w = await unrelated('  Radio cannot be unticked ')
    await addTask(w.projectId, 3, 'Existing backlog', 'backlog')
    const top = Math.max(
      ...(
        await db().selectFrom('tasks').select('position').where('state', '=', 'backlog').execute()
      ).map((r) => r.position),
    )
    const seen = app.bus.next('task.updated', 3_000)
    const res = await settle(w.taskId, w.proposalId, { variant: 'file' })
    expect(res.statusCode).toBe(200)
    await seen
    const filed = await db()
      .selectFrom('tasks')
      .selectAll()
      .where('title', '=', 'Radio cannot be unticked')
      .executeTakeFirstOrThrow()
    expect(filed.state).toBe('backlog')
    expect(filed.position).toBe(top + 1)
    expect(
      filed.description_md.endsWith('\n\nProposed by AIDP-95, Run 2, build; filed by the owner.'),
    ).toBe(true)
    const proposal = await proposalRow(w.proposalId)
    expect(proposal).toMatchObject({ outcome: 'file', filed_task_id: filed.id })
    const event = await db()
      .selectFrom('events')
      .selectAll()
      .where('run_id', '=', w.runId)
      .where('agent', 'is', null)
      .where('type', '=', 'message')
      .executeTakeFirstOrThrow()
    expect(event.payload).toMatchObject({
      summary: `Filed AIDP-${filed.number}: Radio cannot be unticked`,
      proposal: { outcome: 'file' },
    })
    expect((await taskRow(w.taskId)).state).toBe('running')
    expect((await runRow(w.runId)).status).toBe('running')
  })

  it('rolls everything back when the transaction fails (AC18)', async () => {
    const w = await unrelated()
    const before = await db()
      .selectFrom('projects')
      .select('next_task_number')
      .where('id', '=', w.projectId)
      .executeTakeFirstOrThrow()
    const service = new ProposalService(db(), () => new Date())
    await new Promise((resolve) => setTimeout(resolve, 300))
    const quiet = app.bus.next('task.updated', 400).then((message) => message ?? 'silent')
    await expect(
      service.settle(w.taskId, w.proposalId, 'file', {
        beforeCommit: async () => {
          throw new Error('boom')
        },
      }),
    ).rejects.toThrow('boom')
    expect(await quiet).toBe('silent')
    expect((await db().selectFrom('tasks').select('id').execute()).length).toBe(1)
    const after = await db()
      .selectFrom('projects')
      .select('next_task_number')
      .where('id', '=', w.projectId)
      .executeTakeFirstOrThrow()
    expect(after.next_task_number).toBe(before.next_task_number)
    expect((await proposalRow(w.proposalId)).outcome).toBeNull()
  })

  it('creates exactly one task for two concurrent settles (AC19)', async () => {
    const w = await unrelated()
    const [a, b] = await Promise.all([
      settle(w.taskId, w.proposalId, { variant: 'file' }),
      settle(w.taskId, w.proposalId, { variant: 'file' }),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    const loser = a.statusCode === 409 ? a : b
    expect(loser.json().details.reason).toBe('settled')
    expect((await db().selectFrom('tasks').select('id').execute()).length).toBe(2)
  })

  describe('requests (AC21)', () => {
    const rows: {
      name: string
      body: unknown
      status: number
      reason?: string
      other?: boolean
      prepare?: 'settled' | 'duplicate'
    }[] = [
      { name: 'an extra field', body: { variant: 'file', extra: 1 }, status: 400 },
      { name: 'wait', body: { variant: 'wait' }, status: 409, reason: 'not_offered' },
      {
        name: 'workaround on an unrelated one',
        body: { variant: 'workaround' },
        status: 409,
        reason: 'not_offered',
      },
      { name: 'another task', body: { variant: 'file' }, status: 404, other: true },
      {
        name: 'a settled proposal',
        body: { variant: 'file' },
        status: 409,
        reason: 'settled',
        prepare: 'settled',
      },
      {
        name: 'a duplicate title',
        body: { variant: 'file' },
        status: 409,
        reason: 'duplicate',
        prepare: 'duplicate',
      },
    ]
    it.each(rows)('$name', async ({ body, status, reason, other, prepare }) => {
      const w = await unrelated()
      const stranger = await addTask(w.projectId, 40, 'Stranger', 'backlog')
      if (prepare === 'settled') await settle(w.taskId, w.proposalId, { variant: 'dismiss' })
      if (prepare === 'duplicate')
        await addTask(w.projectId, 41, 'radio cannot be unticked', 'backlog')
      const tasksBefore = await db().selectFrom('tasks').select('id').execute()
      const res = await settle(other ? stranger.id : w.taskId, w.proposalId, body)
      expect(res.statusCode).toBe(status)
      if (reason !== undefined) expect(res.json().details.reason).toBe(reason)
      if (prepare === 'duplicate') expect(res.json().details.key).toBe('AIDP-41')
      expect((await db().selectFrom('tasks').select('id').execute()).length).toBe(
        tasksBefore.length,
      )
    })
  })

  it('does not hold back Mark done, and files after the task is Done (AC22)', async () => {
    const w = await unrelated()
    await db().updateTable('tasks').set({ state: 'review' }).where('id', '=', w.taskId).execute()
    const done = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${w.taskId}`,
      payload: { state: 'done' },
    })
    expect(done.statusCode).toBe(200)
    const res = await settle(w.taskId, w.proposalId, { variant: 'file' })
    expect(res.statusCode).toBe(200)
    expect((await proposalRow(w.proposalId)).outcome).toBe('file')
  })
})

describe('settling a related proposal', () => {
  const rows: {
    phase: 'spec' | 'plan'
    variant: 'file' | 'workaround' | 'dismiss'
    message: string
    summary: string
    back: string
  }[] = [
    {
      phase: 'spec',
      variant: 'file',
      message:
        'The owner filed AIDP-1: A finding. Go on with the task unchanged, and name AIDP-1 in your summary.',
      summary: 'Filed AIDP-1: A finding',
      back: 'spec_draft',
    },
    {
      phase: 'plan',
      variant: 'workaround',
      message:
        'The owner filed AIDP-1: A finding, and chose your workaround. Carry it in the plan, naming AIDP-1. The workaround: do it by hand',
      summary: 'Filed AIDP-1 with the workaround: A finding',
      back: 'running',
    },
    {
      phase: 'spec',
      variant: 'dismiss',
      message:
        'The owner dismissed the proposal "A finding"; nothing was filed. Go on with the task unchanged.',
      summary: 'Dismissed: A finding',
      back: 'spec_draft',
    },
    {
      phase: 'plan',
      variant: 'file',
      message:
        'The owner filed AIDP-1: A finding. Go on with the task unchanged, and name AIDP-1 in your summary.',
      summary: 'Filed AIDP-1: A finding',
      back: 'running',
    },
  ]
  it.each(rows)(
    '$phase $variant resumes the session (AC23)',
    async ({ phase, variant, message, summary, back }) => {
      const w = await relatedWorld(phase)
      // The filed task takes the next number of the target project (AIDP-1 is free: the task is AIDP-95).
      await db()
        .updateTable('projects')
        .set({ next_task_number: 1 })
        .where('id', '=', w.projectId)
        .execute()
      expect((await taskRow(w.taskId)).state).toBe('needs_approval')
      const res = await settle(w.taskId, w.proposalId, { variant })
      expect(res.statusCode).toBe(200)
      expect(await runRow(w.runId)).toMatchObject({
        status: 'queued',
        pending: 'resume',
        resume_message: message,
      })
      expect((await approvalOf(w.runId)).status).toBe('answered')
      expect((await taskRow(w.taskId)).state).toBe(back)
      const event = await db()
        .selectFrom('events')
        .selectAll()
        .where('run_id', '=', w.runId)
        .where('agent', 'is', null)
        .where('type', '=', 'message')
        .executeTakeFirstOrThrow()
      expect(event.payload.summary).toBe(summary)
    },
  )

  it('is settled from Blocked once the approval expired (AC15)', async () => {
    const w = await relatedWorld('plan')
    let now = new Date(Date.now())
    const sweeper = new Sweeper(db(), () => now, 60_000, { warn: () => undefined })
    now = new Date(now.getTime() + 48 * 3_600_000 - 60_000)
    await sweeper.tick()
    now = new Date(now.getTime() + 61_000)
    await sweeper.tick()
    expect((await taskRow(w.taskId)).state).toBe('blocked')
    expect((await runRow(w.runId)).block).toMatchObject({ cause: 'approval_expired' })
    expect((await proposalRow(w.proposalId)).outcome).toBeNull()
    const res = await settle(w.taskId, w.proposalId, { variant: 'file' })
    expect(res.statusCode).toBe(200)
    expect((await taskRow(w.taskId)).state).toBe('running')
    expect((await runRow(w.runId)).resume_message).toContain('The owner filed')
  })

  it('withdraws on Cancel, keeping the proposal open for File and Dismiss (AC16)', async () => {
    const w = await relatedWorld('plan')
    expect((await act(w.taskId, 'cancel')).statusCode).toBe(200)
    expect((await approvalOf(w.runId)).status).toBe('withdrawn')
    expect((await proposalRow(w.proposalId)).outcome).toBeNull()
    expect(
      (await settle(w.taskId, w.proposalId, { variant: 'workaround' })).json().details.reason,
    ).toBe('not_offered')
    const filed = await settle(w.taskId, w.proposalId, { variant: 'file' })
    expect(filed.statusCode).toBe(200)
    const run = await runRow(w.runId)
    expect(run.status).toBe('cancelled')
    expect(run.resume_message).toBeNull()
  })

  it('refuses to answer a proposal approval or ask a question help for it (AC26)', async () => {
    const w = await relatedWorld('plan')
    const approval = await approvalOf(w.runId)
    const answer = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval.id}/answer`,
      payload: { option_id: 'file' },
    })
    expect(answer.statusCode).toBe(409)
    expect(answer.json().details.reason).toBe('settle_proposal')
    const help = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval.id}/helps`,
      payload: { mode: 'suggest' },
    })
    expect(help.statusCode).toBe(409)
    expect(help.json().details.reason).toBe('not_offered')
  })
})

describe('the proposal help (AC28, AC29)', () => {
  const ask = (taskId: string, body: unknown) =>
    app.inject({ method: 'POST', url: `/api/tasks/${taskId}/helps`, payload: body as object })

  it('answers the bodies as the table says', async () => {
    const w = await unrelated()
    const rows: { body: unknown; status: number; field?: string; reason?: string }[] = [
      { body: { decision: 'proposal', mode: 'advise' }, status: 400, field: 'proposal_id' },
      {
        body: { decision: 'mark_done', mode: 'check', proposal_id: w.proposalId },
        status: 400,
        field: 'proposal_id',
      },
      {
        body: { decision: 'proposal', mode: 'advise', proposal_id: crypto.randomUUID() },
        status: 409,
        reason: 'not_offered',
      },
    ]
    for (const row of rows) {
      const res = await ask(w.taskId, row.body)
      expect(res.statusCode).toBe(row.status)
      if (row.field !== undefined) expect(JSON.stringify(res.json())).toContain(row.field)
      if (row.reason !== undefined) expect(res.json().details.reason).toBe(row.reason)
    }
    const first = await ask(w.taskId, {
      decision: 'proposal',
      mode: 'advise',
      proposal_id: w.proposalId,
    })
    expect(first.statusCode).toBe(201)
    const second = await ask(w.taskId, {
      decision: 'proposal',
      mode: 'advise',
      proposal_id: w.proposalId,
    })
    expect(second.json().id).toBe(first.json().id)
  })

  it('stops a queued help and retires a succeeded one on settle', async () => {
    const w = await unrelated('First')
    await propose(w, { title: 'Second' })
    const second = await db()
      .selectFrom('proposals')
      .select('id')
      .where('title', '=', 'Second')
      .executeTakeFirstOrThrow()
    const queued = (
      await ask(w.taskId, { decision: 'proposal', mode: 'advise', proposal_id: w.proposalId })
    ).json()
    const done = (
      await ask(w.taskId, { decision: 'proposal', mode: 'advise', proposal_id: second.id })
    ).json()
    await db().updateTable('helps').set({ status: 'succeeded' }).where('id', '=', done.id).execute()
    await settle(w.taskId, w.proposalId, { variant: 'dismiss' })
    await settle(w.taskId, second.id, { variant: 'dismiss' })
    const a = await db()
      .selectFrom('helps')
      .selectAll()
      .where('id', '=', queued.id)
      .executeTakeFirstOrThrow()
    expect(a.status).toBe('stopped')
    expect((await runRow(a.run_id)).status).toBe('cancelled')
    const b = await db()
      .selectFrom('helps')
      .selectAll()
      .where('id', '=', done.id)
      .executeTakeFirstOrThrow()
    expect(b.retired_at).not.toBeNull()
    void sql
  })
})
