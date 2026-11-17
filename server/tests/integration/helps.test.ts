import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from '../../src/db/migrations/index.js'
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

  it('queues one review_plan help on a plan request', async () => {
    const plan = await open({
      kind: 'plan',
      options: [],
      recommendation: null,
      context_md: '# Plan',
    })
    const first = await ask(plan.approvalId, { mode: 'review_plan' })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({ mode: 'review_plan', status: 'queued' })
    const second = await ask(plan.approvalId, { mode: 'review_plan' })
    expect(second.json().id).toBe(first.json().id)
    const rows = await db()
      .selectFrom('helps')
      .select('id')
      .where('approval_id', '=', plan.approvalId)
      .execute()
    expect(rows).toHaveLength(1)
  })

  it('refuses review_plan on a request that is not a plan', async () => {
    const other = await open({
      kind: 'out_of_plan',
      files: ['a.ts'],
      options: [],
      recommendation: null,
    })
    const refused = await ask(other.approvalId, { mode: 'review_plan' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().details).toMatchObject({ reason: 'not_offered' })
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
        'list_projects',
        'list_tasks',
        'read_task',
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

describe('Suggest an answer on a batch', () => {
  const BATCH = {
    kind: 'questions' as const,
    question: 'lead',
    options: [],
    questions: [
      { question: 'One?', options: [A, B] },
      { question: 'Two?', options: [{ id: 'x', label: 'X' }] },
      { question: 'Three?' },
    ],
  }
  const setting = (projectId: string, value: 'whole' | 'one') =>
    db().updateTable('projects').set({ batch_suggest: value }).where('id', '=', projectId).execute()
  const helpsOf = (approvalId: string) =>
    db().selectFrom('helps').selectAll().where('approval_id', '=', approvalId).execute()

  it('records one whole-batch help on whole, and joins it while it is queued', async () => {
    const { approvalId } = await open(BATCH)
    const first = await ask(approvalId, { mode: 'suggest', question_index: 1 })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({ mode: 'suggest_all', question_index: null })
    const second = await ask(approvalId, { mode: 'suggest', question_index: 2 })
    expect(second.json().id).toBe(first.json().id)
    expect(await helpsOf(approvalId)).toHaveLength(1)
  })

  it('records a help for the question on one', async () => {
    const { approvalId, projectId } = await open(BATCH)
    await setting(projectId, 'one')
    const res = await ask(approvalId, { mode: 'suggest', question_index: 1 })
    expect(res.json()).toMatchObject({ mode: 'suggest', question_index: 1 })
  })

  it.each(['whole', 'one'] as const)(
    'answers with a running whole-batch help on %s',
    async (value) => {
      const { approvalId, projectId } = await open(BATCH)
      await setting(projectId, 'whole')
      const whole = (await ask(approvalId, { mode: 'suggest', question_index: 0 })).json()
      await claim()
      await setting(projectId, value)
      const again = await ask(approvalId, { mode: 'suggest', question_index: 2 })
      expect(again.json().id).toBe(whole.id)
      expect(await helpsOf(approvalId)).toHaveLength(1)
    },
  )

  it('leaves a single request as it was, on whole', async () => {
    const single = await open()
    expect((await ask(single.approvalId, { mode: 'suggest' })).json()).toMatchObject({
      mode: 'suggest',
      question_index: null,
    })
  })

  it('leaves Explain on a batch question as it was, on whole', async () => {
    const batch = await open(BATCH)
    expect(
      (await ask(batch.approvalId, { mode: 'explain', question_index: 1 })).json(),
    ).toMatchObject({ mode: 'explain', question_index: 1 })
  })

  it('refuses a client that asks for suggest_all by name', async () => {
    const { approvalId } = await open(BATCH)
    const res = await ask(approvalId, { mode: 'suggest_all' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('validation_error')
  })

  it('still refuses a question the batch lacks, on whole', async () => {
    const { approvalId } = await open(BATCH)
    expect((await ask(approvalId, { mode: 'suggest', question_index: 3 })).statusCode).toBe(400)
    expect(await helpsOf(approvalId)).toHaveLength(0)
  })
})

describe('a whole-batch help through its life', () => {
  const BATCH = {
    kind: 'questions' as const,
    question: 'lead',
    options: [],
    questions: [
      { question: 'One?', options: [A, B], recommendation: 'a' },
      { question: 'Two?', options: [{ id: 'x', label: 'X' }] },
      { question: 'Three?' },
    ],
  }
  const ok = (id: string, change: Record<string, unknown> = {}) => ({
    question_id: id,
    option_id: id === 'q2' ? 'x' : 'a',
    reasoning: ' r ',
    unsure: 'u',
    ...change,
  })

  async function running() {
    const seeded = await open(BATCH)
    const help = (await ask(seeded.approvalId, { mode: 'suggest', question_index: 0 })).json()
    await claim()
    return {
      ...seeded,
      helpId: help.id as string,
      ...(await tools(seeded.runId, seeded.taskId, help.id)),
    }
  }

  it('reads every question of the batch in order', async () => {
    const { call } = await running()
    const read = JSON.parse((await call('get_question')).content[0]!.text)
    expect(read.kind).toBe('questions')
    expect(read.batch_lead).toBe('lead')
    expect(read.questions.map((q: { id: string }) => q.id)).toEqual(['q1', 'q2', 'q3'])
    expect(read.questions[0]).toMatchObject({
      id: 'q1',
      question: 'One?',
      options: [A, B],
      recommendation: 'a',
    })
    expect(Object.keys(read.questions[0]).sort()).toEqual(
      ['context_md', 'id', 'options', 'question', 'recommendation'].sort(),
    )
  })

  const refusals: { name: string; save: () => Record<string, unknown>; field: string }[] = [
    {
      name: 'a missing q3',
      save: () => ({ answers: [ok('q1'), ok('q2')] }),
      field: 'answers: required',
    },
    {
      name: 'an unknown q9',
      save: () => ({ answers: [ok('q1'), ok('q2'), ok('q3', { question_id: 'q9' })] }),
      field: 'answers: unknown question',
    },
    {
      name: 'a repeated q1',
      save: () => ({ answers: [ok('q1'), ok('q1'), ok('q2'), ok('q3')] }),
      field: 'answers: duplicate',
    },
    {
      name: 'an option q2 does not offer',
      save: () => ({ answers: [ok('q1'), ok('q2', { option_id: 'a' }), ok('q3')] }),
      field: 'answers[1].option_id: unknown option',
    },
    {
      name: 'neither option nor words',
      save: () => ({ answers: [ok('q1'), ok('q2'), ok('q3', { option_id: undefined })] }),
      field: 'answers[2].option_id: required',
    },
    {
      name: 'a blank reasoning',
      save: () => ({ answers: [ok('q1', { reasoning: ' ' }), ok('q2'), ok('q3')] }),
      field: 'answers[0].reasoning: required',
    },
    {
      name: 'an extra asked field',
      save: () => ({ answers: [ok('q1'), ok('q2'), ok('q3')], asked: 'q' }),
      field: 'asked: not allowed',
    },
  ]
  it.each(refusals)('refuses $name and stores nothing', async ({ save, field }) => {
    const { call, helpId } = await running()
    const res = await call('save_help_result', save())
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain(`- ${field}`)
    expect(await helpRow(helpId)).toMatchObject({ status: 'running', result: null })
  })

  it('stores a valid save in the batch order, trimmed', async () => {
    const { call, helpId } = await running()
    const res = await call('save_help_result', {
      answers: [ok('q3', { option_id: undefined, text: ' Teal ' }), ok('q1'), ok('q2')],
    })
    expect(res.isError).toBeUndefined()
    expect(await helpRow(helpId)).toMatchObject({
      status: 'succeeded',
      result: {
        mode: 'suggest_all',
        answers: [
          { question_id: 'q1', option_id: 'a', reasoning: 'r', unsure: 'u' },
          { question_id: 'q2', option_id: 'x', reasoning: 'r', unsure: 'u' },
          { question_id: 'q3', text: 'Teal', reasoning: 'r', unsure: 'u' },
        ],
      },
    })
  })

  it('refuses answers from a suggest help', async () => {
    const seeded = await open()
    const help = (await ask(seeded.approvalId, { mode: 'suggest' })).json()
    await claim()
    const { call } = await tools(seeded.runId, seeded.taskId, help.id)
    const res = await call('save_help_result', {
      option_id: 'a',
      reasoning: 'r',
      unsure: 'u',
      answers: [ok('q1')],
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('- answers: not allowed')
  })
})

describe('migration 015', () => {
  const migrator = () =>
    new Migrator({ db: getTestDb(), provider: { getMigrations: async () => migrations } })

  let runId = ''
  async function seedHelp(decision: string, mode: string, status: string): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into helps (run_id, decision, mode, status)
      values (${runId}, ${decision}, ${mode}, ${status}) returning id`.execute(db())
    return rows[0]!.id
  }

  it('retires succeeded reviews, accepts review_plan, and refuses down while one exists', async () => {
    expect((await migrator().migrateTo('014_batch_suggest')).error).toBeUndefined()
    runId = (await seedRunningRun(db())).runId
    const review = await seedHelp('spec_review', 'review', 'succeeded')
    const code = await seedHelp('pull_request', 'code_review', 'succeeded')
    const restate = await seedHelp('spec_review', 'restate', 'succeeded')
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    const { rows } = await sql<{ id: string; retired: boolean }>`
      select id, retired_at is not null as retired from helps`.execute(db())
    const retired = new Map(rows.map((row) => [row.id, row.retired]))
    expect([retired.get(review), retired.get(code), retired.get(restate)]).toEqual([
      true,
      true,
      false,
    ])
    const approval = await sql<{ id: string }>`
      insert into approval_requests (run_id, kind, question, status)
      values (${runId}, 'plan', 'Plan?', 'open') returning id`.execute(db())
    const planHelp = await sql<{ id: string }>`
      insert into helps (run_id, approval_id, decision, mode, status)
      values (${runId}, ${approval.rows[0]!.id}, 'question', 'review_plan', 'queued')
      returning id`.execute(db())
    const plan = planHelp.rows[0]!.id
    await expect(seedHelp('spec_review', 'review_plan', 'queued')).rejects.toThrow()
    const down = await migrator().migrateTo('014_batch_suggest')
    expect(String(down.error)).toContain('plan reviews exist')
    await sql`delete from helps where id = ${plan}`.execute(db())
    expect((await migrator().migrateTo('014_batch_suggest')).error).toBeUndefined()
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
  })
})

describe('get_question for a plan review: previous', () => {
  const plan = (n: number) => Array.from({ length: n }, (_, i) => `step ${i + 1}`).join('\n')

  async function seedPlanReview(first: { text: string | null; context: string }, second: string) {
    const run = await seedRunningRun(db())
    const insert = (context: string, status: 'answered' | 'open', answer: unknown, at: string) =>
      db()
        .insertInto('approval_requests')
        .values({
          run_id: run.runId,
          kind: 'plan',
          question: 'Approve?',
          options: '[]',
          recommendation: null,
          phase_id: null,
          checkpoint: null,
          context_md: context,
          status,
          answer: answer === null ? null : JSON.stringify(answer),
          answered_at: status === 'answered' ? new Date(at) : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    const earlier = await insert(
      first.context,
      'answered',
      first.text === null ? { option_id: 'approve' } : { text: first.text },
      '2026-10-20T09:00:00Z',
    )
    const current = await insert(second, 'open', null, '2026-10-20T09:30:00Z')
    const help = await db()
      .insertInto('helps')
      .values({
        run_id: run.runId,
        approval_id: current.id,
        decision: 'question',
        mode: 'review_plan',
        status: 'running',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { ...run, earlierId: earlier.id, helpId: help.id }
  }

  const previous = async (s: { runId: string; taskId: string; helpId: string }) => {
    const { call } = await tools(s.runId, s.taskId, s.helpId)
    return JSON.parse((await call('get_question')).content[0]!.text).previous
  }

  it('is null on the first plan request', async () => {
    const run = await seedRunningRun(db())
    const approval = await db()
      .insertInto('approval_requests')
      .values({
        run_id: run.runId,
        kind: 'plan',
        question: 'Approve?',
        options: '[]',
        recommendation: null,
        phase_id: null,
        checkpoint: null,
        context_md: plan(3),
        status: 'open',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const help = await db()
      .insertInto('helps')
      .values({
        run_id: run.runId,
        approval_id: approval.id,
        decision: 'question',
        mode: 'review_plan',
        status: 'running',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    expect(await previous({ ...run, helpId: help.id })).toBeNull()
  })

  it('is null when the earlier request was approved without words', async () => {
    const s = await seedPlanReview({ text: null, context: plan(3) }, plan(4))
    expect(await previous(s)).toBeNull()
  })

  it('holds the diff, the owner’s words and no earlier review', async () => {
    const s = await seedPlanReview({ text: 'Add a retry step', context: plan(30) }, plan(31))
    const got = await previous(s)
    expect(got.answer).toBe('Add a retry step')
    expect(got.diff).toContain('+step 31')
    expect(got.earlier_review).toBeNull()
  })

  it('returns the earlier review without unsure', async () => {
    const s = await seedPlanReview({ text: 'Add a retry step', context: plan(3) }, plan(4))
    await db()
      .insertInto('helps')
      .values({
        run_id: s.runId,
        approval_id: s.earlierId,
        decision: 'question',
        mode: 'review_plan',
        status: 'succeeded',
        result: JSON.stringify({
          mode: 'review_plan',
          verdict: 'changes',
          blockers: 1,
          findings: [{ kind: 'risk', text: 'T', destination: 'blocker', evidence: 'e' }],
          unsure: 'secret',
        }),
      })
      .execute()
    const got = await previous(s)
    expect(got.earlier_review).toMatchObject({ verdict: 'changes' })
    expect(JSON.stringify(got.earlier_review)).not.toContain('unsure')
  })

  it('gives the whole earlier plan when the differing middles are too large', async () => {
    const before = Array.from({ length: 3_000 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 3_000 }, (_, i) => `new ${i}`).join('\n')
    const s = await seedPlanReview({ text: 'Redo it', context: before }, after)
    expect((await previous(s)).diff).toBe(before)
  })
})
