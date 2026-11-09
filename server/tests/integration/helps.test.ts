import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openApproval, type OpenRequest } from '../../src/modules/approvals/approval.service.js'
import { registerBoardTools } from '../../src/modules/mcp/board-tools.js'
import { Sweeper } from '../../src/modules/runs/sweeper.js'
import { seedRunningRun } from './fixtures.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'

let app: FastifyInstance
let now = new Date('2026-10-20T10:00:00Z')
const runner = { authorization: `Bearer ${TEST_RUNNER_KEY}` }

beforeAll(async () => {
  app = await buildTestApp({ clock: () => now })
})
beforeEach(async () => {
  await resetDb()
  now = new Date('2026-10-20T10:00:00Z')
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const db = () => getTestDb()
const A = { id: 'a', label: 'Red' }
const B = { id: 'b', label: 'Blue' }

async function open(change: Partial<OpenRequest> = {}) {
  const run = await seedRunningRun(db())
  const opened = await db()
    .transaction()
    .execute((trx) =>
      openApproval(
        trx,
        {
          runId: run.runId,
          taskId: run.taskId,
          phaseId: run.phaseId,
          kind: 'question',
          question: 'Which colour?',
          options: [A, B],
          recommendation: 'b',
          ...change,
        },
        now,
        { recordEvent: true },
      ),
    )
  return { ...run, approvalId: opened.id }
}

const ask = (approvalId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/approvals/${approvalId}/helps`, payload })
const helpRow = (id: string) =>
  db().selectFrom('helps').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
const claim = async () =>
  (
    await app.inject({
      method: 'POST',
      url: '/api/runner/helps/claim',
      headers: runner,
      payload: { runner_id: 'r1', wait_ms: 0 },
    })
  ).json().help as { id: string; phase_id: string } | null

async function tools(runId: string, taskId: string, helpId: string | null) {
  const server = new McpServer({ name: 'board', version: '1.0.0' })
  registerBoardTools(server, { db: db(), runId, taskId, helpId, clock: () => now })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(b)
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean
      content: { text: string }[]
    }
  return { client, call }
}

describe('asking for a help', () => {
  it('records a queued help and moves nothing else', async () => {
    const { approvalId, runId, taskId, phaseId } = await open()
    const before = await db()
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()

    const res = await ask(approvalId, { mode: 'suggest' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ mode: 'suggest', status: 'queued', question_index: null })

    const after = await db()
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(after.status).toBe('paused')
    expect(after.pending).toBeNull()
    expect(after.resume_message).toBe(before.resume_message)
    const phase = await db()
      .selectFrom('phases')
      .select('status')
      .where('id', '=', phaseId)
      .executeTakeFirstOrThrow()
    expect(phase.status).toBe('paused')
    const task = await db()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
    expect(task.state).toBe('needs_approval')
  })

  it('starts nothing more while one of the same mode is in flight', async () => {
    const { approvalId } = await open()
    const first = (await ask(approvalId, { mode: 'suggest' })).json()
    const second = (await ask(approvalId, { mode: 'suggest' })).json()
    expect(second.id).toBe(first.id)
    const other = (await ask(approvalId, { mode: 'explain' })).json()
    expect(other.id).not.toBe(first.id)
  })

  it.each([['a question a single request lacks', { mode: 'suggest', question_index: 0 }]])(
    'refuses %s',
    async (_name, payload) => {
      const { approvalId } = await open()
      expect((await ask(approvalId, payload)).statusCode).toBe(400)
    },
  )

  it('refuses a request that is no longer current', async () => {
    const { approvalId } = await open()
    await db()
      .updateTable('approval_requests')
      .set({ status: 'answered' })
      .where('id', '=', approvalId)
      .execute()
    expect((await ask(approvalId, { mode: 'explain' })).statusCode).toBe(409)
  })

  it('asks for a question of a batch by its index', async () => {
    const { approvalId } = await open({
      kind: 'questions',
      question: '',
      options: [],
      questions: [{ question: 'One?', options: [A, B] }, { question: 'Two?' }],
    })
    expect((await ask(approvalId, { mode: 'suggest', question_index: 1 })).statusCode).toBe(201)
    expect((await ask(approvalId, { mode: 'suggest', question_index: 2 })).statusCode).toBe(400)
    expect((await ask(approvalId, { mode: 'suggest' })).statusCode).toBe(400)
  })
})

describe('a help through its life', () => {
  it('is claimed, tokened, tool-limited, saved with refusals first, and shown', async () => {
    const { approvalId, runId, taskId } = await open()
    const queued = (await ask(approvalId, { mode: 'suggest' })).json()

    const work = await claim()
    expect(work?.id).toBe(queued.id)
    expect(await helpRow(queued.id)).toMatchObject({ status: 'running', runner_id: 'r1' })
    expect(await claim()).toBeNull()

    const issued = await app.inject({
      method: 'POST',
      url: `/api/runner/helps/${queued.id}/tokens`,
      headers: runner,
    })
    const token = issued.json().token as string
    const held = await db().selectFrom('run_tokens').select(['run_id', 'help_id']).execute()
    expect(held).toEqual([{ run_id: runId, help_id: queued.id }])
    expect(token.length).toBeGreaterThan(20)

    const { client, call } = await tools(runId, taskId, queued.id)
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'get_decision',
        'get_question',
        'get_phase_record',
        'get_spec',
        'get_task',
        'save_help_result',
      ].sort(),
    )

    const read = JSON.parse((await call('get_question')).content[0]!.text)
    expect(read).toMatchObject({ question: 'Which colour?', options: [A, B], recommendation: 'b' })

    const wrongOption = await call('save_help_result', {
      option_id: 'c',
      reasoning: 'r',
      unsure: 'u',
    })
    expect(wrongOption.isError).toBe(true)
    expect(wrongOption.content[0]!.text).toContain('option_id')
    const empty = await call('save_help_result', { reasoning: 'r', unsure: 'u' })
    expect(empty.isError).toBe(true)
    expect((await helpRow(queued.id)).status).toBe('running')

    expect(
      (await call('save_help_result', { option_id: 'b', reasoning: 'r', unsure: 'u' })).isError,
    ).toBeUndefined()
    expect(await helpRow(queued.id)).toMatchObject({
      status: 'succeeded',
      result: { mode: 'suggest', option_id: 'b', reasoning: 'r', unsure: 'u' },
    })

    const shown = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/helps` })).json()
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ status: 'succeeded' })
  })

  it('refuses an explanation that carries an option, and accepts three parts', async () => {
    const { approvalId, runId, taskId } = await open()
    const queued = (await ask(approvalId, { mode: 'explain' })).json()
    await claim()
    const { call } = await tools(runId, taskId, queued.id)
    const parts = { asked: 'q', matters: 'm', leads_to: 'l' }
    expect((await call('save_help_result', { ...parts, option_id: 'a' })).isError).toBe(true)
    expect((await call('save_help_result', parts)).isError).toBeUndefined()
    expect((await helpRow(queued.id)).result).toEqual({ mode: 'explain', ...parts })
  })

  it('tells a stopped help to stop at its heartbeat, and not one that has saved', async () => {
    const { approvalId, runId, taskId } = await open()
    const saved = (await ask(approvalId, { mode: 'explain' })).json()
    const running = (await ask(approvalId, { mode: 'suggest' })).json()
    await claim()
    await claim()
    const { call } = await tools(runId, taskId, saved.id)
    await call('save_help_result', { asked: 'q', matters: 'm', leads_to: 'l' })

    const beat = async () =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/runner/helps/heartbeat',
          headers: runner,
          payload: { runner_id: 'r1', help_ids: [saved.id, running.id] },
        })
      ).json()
    expect(await beat()).toEqual({ stop: [] })

    const res = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approvalId}/answer`,
      payload: { option_id: 'a' },
    })
    expect(res.statusCode).toBe(200)
    expect((await helpRow(running.id)).status).toBe('stopped')
    expect((await helpRow(saved.id)).status).toBe('succeeded')
    expect(await beat()).toEqual({ stop: [running.id] })
  })

  it('refuses a save from a stopped help, and builds the resume message from the answer alone', async () => {
    const { approvalId, runId, taskId } = await open()
    const queued = (await ask(approvalId, { mode: 'suggest' })).json()
    await claim()
    await app.inject({
      method: 'POST',
      url: `/api/approvals/${approvalId}/answer`,
      payload: { option_id: 'a' },
    })
    const { call } = await tools(runId, taskId, queued.id)
    expect(
      (await call('save_help_result', { option_id: 'b', reasoning: 'r', unsure: 'u' })).isError,
    ).toBe(true)
    expect((await helpRow(queued.id)).result).toBeNull()
    const run = await db()
      .selectFrom('runs')
      .select('resume_message')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run.resume_message).toBe('The owner answered your question:\n\nRed')
  })

  it('is stopped by Cancel, queued and running alike', async () => {
    const { approvalId, taskId } = await open()
    const one = (await ask(approvalId, { mode: 'suggest' })).json()
    const two = (await ask(approvalId, { mode: 'explain' })).json()
    await claim()
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/actions/cancel` })
    expect(res.statusCode).toBeLessThan(300)
    expect((await helpRow(one.id)).status).toBe('stopped')
    expect((await helpRow(two.id)).status).toBe('stopped')
  })

  it('fails by the runner’s word and shows the reason', async () => {
    const { approvalId, taskId } = await open()
    const queued = (await ask(approvalId, { mode: 'suggest' })).json()
    await claim()
    const res = await app.inject({
      method: 'POST',
      url: `/api/runner/helps/${queued.id}/fail`,
      headers: runner,
      payload: { reason: 'the helper ended without a result' },
    })
    expect(res.statusCode).toBe(204)
    const shown = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/helps` })).json()
    expect(shown[0]).toMatchObject({
      status: 'failed',
      reason: 'the helper ended without a result',
    })
    expect((await ask(approvalId, { mode: 'suggest' })).statusCode).toBe(201)
  })

  it('closes the Help phase failed and interrupted when the runner reports a failure', async () => {
    const { approvalId, runId } = await open()
    const queued = (await ask(approvalId, { mode: 'suggest' })).json()
    const work = await claim()
    await db()
      .insertInto('phases')
      .values({
        id: work!.phase_id,
        run_id: runId,
        name: 'help',
        attempt: 1,
        agent: 'helper',
        model: 'opus',
        status: 'running',
        session_id: null,
        summary_md: null,
        reported_cost: null,
        started_at: now,
        ended_at: null,
      })
      .execute()
    await app.inject({
      method: 'POST',
      url: `/api/runner/helps/${queued.id}/fail`,
      headers: runner,
      payload: { reason: 'runner restarted' },
    })
    const phase = await db()
      .selectFrom('phases')
      .select(['status', 'interrupted'])
      .where('id', '=', work!.phase_id)
      .executeTakeFirstOrThrow()
    expect(phase).toEqual({ status: 'failed', interrupted: true })
  })

  it('queues a claimed help again on release, for another claim', async () => {
    const { approvalId } = await open()
    const queued = (await ask(approvalId, { mode: 'suggest' })).json()
    await claim()
    const release = (runnerId: string) =>
      app.inject({
        method: 'POST',
        url: `/api/runner/helps/${queued.id}/release`,
        headers: runner,
        payload: { runner_id: runnerId },
      })
    expect((await release('other')).statusCode).toBe(204)
    expect((await helpRow(queued.id)).status).toBe('running')
    expect((await release('r1')).statusCode).toBe(204)
    expect(await helpRow(queued.id)).toMatchObject({
      status: 'queued',
      runner_id: null,
      phase_id: null,
    })
    expect((await claim())?.id).toBe(queued.id)
  })

  it('is failed by the sweeper after 90 s, and its Help phase closes', async () => {
    const { approvalId, runId } = await open()
    const queued = (await ask(approvalId, { mode: 'suggest' })).json()
    const work = await claim()
    await db()
      .insertInto('phases')
      .values({
        id: work!.phase_id,
        run_id: runId,
        name: 'help',
        attempt: 1,
        agent: 'helper',
        model: 'opus',
        status: 'running',
        session_id: null,
        summary_md: null,
        reported_cost: null,
        started_at: now,
        ended_at: null,
      })
      .execute()
    const sweeper = new Sweeper(db(), () => now, 60_000, { warn: () => undefined })
    now = new Date(now.getTime() + 30_000)
    await sweeper.tick()
    now = new Date(now.getTime() + 61_000)
    const decision = await sweeper.tick()
    expect(decision).toMatchObject({ rearm: false, lostHelps: [queued.id] })
    expect((await helpRow(queued.id)).status).toBe('failed')
    const phase = await db()
      .selectFrom('phases')
      .select(['status', 'interrupted'])
      .where('id', '=', work!.phase_id)
      .executeTakeFirstOrThrow()
    expect(phase).toEqual({ status: 'failed', interrupted: true })
  })
})
