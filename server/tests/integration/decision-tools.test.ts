import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerBoardTools } from '../../src/modules/mcp/board-tools.js'
import type { Block, Checkpoint, TaskState } from '../../src/shared/vocabulary.js'
import { GOOD_SPEC, seedQueuedRun } from './fixtures.js'
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

async function tools(taskId: string, runId: string, helpId: string) {
  const server = new McpServer({ name: 'board', version: '1.0.0' })
  registerBoardTools(server, { db: db(), runId, taskId, helpId, clock: () => new Date() })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(b)
  return async (name: string, args: Record<string, unknown> = {}) => {
    const out = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean
      content: { text: string }[]
    }
    return { isError: out.isError === true, text: out.content[0]!.text }
  }
}

interface Seed {
  state: TaskState
  run?: {
    status: 'blocked' | 'failed' | 'succeeded'
    block?: Block
    checkpoint?: Checkpoint
    pr?: number
    branch?: string
  }
}

type CardDecision = 'spec_review' | 'stopped_run' | 'mark_done' | 'pull_request'

/** A delivery card in `state`, its run as given, and a running help of the decision. */
async function seed(spec: Seed, decision: CardDecision, mode: string) {
  const card = await seedQueuedRun(db(), { state: spec.state })
  if (spec.state === 'spec_review' || spec.state === 'backlog') {
    await db().deleteFrom('runs').where('id', '=', card.runId).execute()
    if (spec.state === 'backlog')
      await db().deleteFrom('specs').where('task_id', '=', card.taskId).execute()
    else
      await db()
        .updateTable('specs')
        .set({ status: 'draft', approved_at: null })
        .where('task_id', '=', card.taskId)
        .execute()
  } else if (spec.run !== undefined) {
    await db()
      .updateTable('runs')
      .set({
        status: spec.run.status,
        queued_at: null,
        block: spec.run.block === undefined ? null : JSON.stringify(spec.run.block),
        checkpoint: spec.run.checkpoint === undefined ? null : JSON.stringify(spec.run.checkpoint),
        failure_reason: spec.run.status === 'failed' ? 'tests failed' : null,
        ...(spec.run.pr === undefined
          ? {}
          : {
              pr_number: spec.run.pr,
              pr_url: `https://github.com/owner/pay/pull/${spec.run.pr}`,
            }),
        ...(spec.run.branch === undefined ? {} : { branch: spec.run.branch }),
      })
      .where('id', '=', card.runId)
      .execute()
  }
  const response = await app.inject({
    method: 'POST',
    url: `/api/tasks/${card.taskId}/helps`,
    payload: { decision, mode },
  })
  expect(response.statusCode).toBe(201)
  const help = response.json() as { id: string }
  await db()
    .updateTable('helps')
    .set({ status: 'running', runner_id: 'r1' })
    .where('id', '=', help.id)
    .execute()
  const row = await db()
    .selectFrom('helps')
    .select('run_id')
    .where('id', '=', help.id)
    .executeTakeFirstOrThrow()
  return { ...card, helpId: help.id, helpRunId: row.run_id }
}

const CHECKPOINT: Checkpoint = {
  stage: 'build',
  attempt: 1,
  phase_id: null,
  head: null,
  plan_artifact_id: null,
  failing_report_id: null,
  session: { id: 's', baseline: {}, reported: {} },
}
const statusOf = async (table: 'helps' | 'runs', id: string) =>
  (await db().selectFrom(table).select('status').where('id', '=', id).executeTakeFirstOrThrow())
    .status

describe('get_decision for Mark done', () => {
  const rows: { state: TaskState; seed: Seed; against: string; spec: boolean }[] = [
    {
      state: 'review',
      seed: { state: 'review', run: { status: 'succeeded' } },
      against: 'approved_spec',
      spec: true,
    },
    { state: 'spec_review', seed: { state: 'spec_review' }, against: 'latest_spec', spec: true },
    { state: 'backlog', seed: { state: 'backlog' }, against: 'description', spec: false },
  ]
  it.each(rows)('reads $against in $state (AC19)', async (row) => {
    const s = await seed(row.seed, 'mark_done', 'check')
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    const record = JSON.parse((await call('get_decision')).text)
    expect(record.checked_against).toBe(row.against)
    expect(record.spec !== null).toBe(row.spec)
  })
})

describe('get_decision for a stopped run', () => {
  it('returns the block, the actions and refuses get_question (AC20)', async () => {
    const s = await seed(
      {
        state: 'blocked',
        run: {
          status: 'blocked',
          block: { cause: 'step_failed', stage: 'build', command: 'git fetch', output: 'denied' },
          checkpoint: CHECKPOINT,
        },
      },
      'stopped_run',
      'recommend',
    )
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    const record = JSON.parse((await call('get_decision')).text)
    expect(record.block).toMatchObject({ command: 'git fetch', output: 'denied' })
    expect(record.actions).toEqual(['resume', 'cancel'])
    expect(record.resumable).toBe(true)
    const refused = await call('get_question')
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('get_decision')
  })

  it('says a run with no checkpoint cannot be resumed (AC43)', async () => {
    const s = await seed(
      {
        state: 'blocked',
        run: { status: 'blocked', block: { cause: 'runner_lost', stage: 'build' } },
      },
      'stopped_run',
      'recommend',
    )
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    const record = JSON.parse((await call('get_decision')).text)
    expect(record).toMatchObject({ checkpoint: null, resumable: false })
    expect(record.not_resumable).toBe(
      'Resume would answer 409 no_checkpoint: this run left no checkpoint to resume from.',
    )
    expect(record.recommendable_actions).toEqual(['cancel'])
    const saved = await call('save_help_result', {
      why_stopped: 'w',
      action: 'resume',
      reasoning: 'r',
      unsure: 'u',
    })
    expect(saved.isError).toBe(true)
    expect(saved.text).toContain('action: not offered')
  })

  it('refuses get_question on a decision help of any kind', async () => {
    const s = await seed({ state: 'spec_review' }, 'spec_review', 'review')
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    expect((await call('get_question')).text).toContain('get_decision')
  })
})

describe('get_phase_record for a stopped run', () => {
  const rows = [
    { name: 'no entries', count: 0, leftOut: 0, first: null },
    { name: 'exactly 300 entries', count: 300, leftOut: 0, first: 1 },
    { name: '450 entries', count: 450, leftOut: 150, first: 151 },
  ]
  it.each(rows)('reads $name (AC49)', async ({ count, leftOut, first }) => {
    const s = await seed({ state: 'failed', run: { status: 'failed' } }, 'stopped_run', 'recommend')
    const phaseId = crypto.randomUUID()
    await db()
      .insertInto('phases')
      .values({
        id: phaseId,
        run_id: s.runId,
        name: 'build',
        attempt: 1,
        agent: 'builder',
        model: 'sonnet',
        status: 'failed',
        session_id: null,
        summary_md: null,
        reported_cost: null,
        started_at: new Date(),
      })
      .execute()
    const base = Date.parse('2026-10-20T10:00:00Z')
    for (let i = 1; i <= count; i++)
      await db()
        .insertInto('events')
        .values({
          id: crypto.randomUUID(),
          run_id: s.runId,
          phase_id: phaseId,
          ts: new Date(base + i * 1000),
          type: 'tool_call',
          agent: 'builder',
          model: 'sonnet',
          tool: 'Read',
          target: `file-${i}`,
          status: 'ok',
          duration_ms: 1,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          payload: JSON.stringify({}),
        } as never)
        .execute()
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    const record = JSON.parse((await call('get_phase_record')).text)
    expect(record.earlier_left_out).toBe(leftOut)
    expect(record.entries).toHaveLength(Math.min(count, 300))
    if (first !== null) {
      expect(record.entries[0].target).toBe(`file-${first}`)
      expect(record.entries.at(-1).target).toBe(`file-${count}`)
    }
  })
})

describe('save_help_result for a decision help', () => {
  it('saves a result and ends the run (AC9)', async () => {
    const s = await seed({ state: 'spec_review' }, 'spec_review', 'review')
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    const saved = await call('save_help_result', {
      verdict: 'nothing_to_change',
      unsure: 'nothing',
    })
    expect(saved.isError).toBe(false)
    expect(await statusOf('runs', s.helpRunId)).toBe('succeeded')
    expect(await statusOf('helps', s.helpId)).toBe('succeeded')
  })

  it('refuses a field of another mode, naming it', async () => {
    const s = await seed({ state: 'spec_review' }, 'spec_review', 'restate')
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    const saved = await call('save_help_result', {
      changes: 'c',
      requirements: 'r',
      left_out: 'l',
      verdict: 'changes',
    })
    expect(saved.text).toContain('verdict: not allowed')
  })

  it('saves nothing once a new version is saved, and keeps both statuses (AC22)', async () => {
    const s = await seed({ state: 'spec_review' }, 'spec_review', 'review')
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    await app.inject({
      method: 'POST',
      url: `/api/tasks/${s.taskId}/specs`,
      payload: { body_md: GOOD_SPEC + '\nmore' },
    })
    expect(await statusOf('helps', s.helpId)).toBe('stopped')
    expect(await statusOf('runs', s.helpRunId)).toBe('cancelled')
    const saved = await call('save_help_result', { verdict: 'nothing_to_change', unsure: 'u' })
    expect(saved.isError).toBe(true)
    expect(saved.text).toBe(
      'This decision is no longer offered; nothing was saved. End your turn now.',
    )
    const after = await db()
      .selectFrom('helps')
      .select(['status', 'result'])
      .where('id', '=', s.helpId)
      .executeTakeFirstOrThrow()
    expect(after).toEqual({ status: 'stopped', result: null })
    expect(await statusOf('runs', s.helpRunId)).toBe('cancelled')
  })

  it('is stopped with its run when Resume is pressed (AC23)', async () => {
    const s = await seed(
      {
        state: 'blocked',
        run: {
          status: 'blocked',
          block: { cause: 'step_failed', stage: 'build' },
          checkpoint: CHECKPOINT,
        },
      },
      'stopped_run',
      'recommend',
    )
    const resumed = await app.inject({
      method: 'POST',
      url: `/api/tasks/${s.taskId}/actions/resume`,
    })
    expect(resumed.statusCode).toBe(200)
    expect(await statusOf('helps', s.helpId)).toBe('stopped')
    expect(await statusOf('runs', s.helpRunId)).toBe('cancelled')
  })
})

describe('a pull request review', () => {
  const REVIEWED = {
    state: 'review',
    run: { status: 'succeeded', pr: 7, branch: 'feat/x' },
  } as const

  it('reads the run, the spec, the plan and the report (AC13)', async () => {
    const s = await seed(REVIEWED, 'pull_request', 'code_review')
    await db()
      .insertInto('artifacts')
      .values([
        {
          run_id: s.runId,
          kind: 'plan',
          body_md: 'The plan',
          uri: null,
          data: JSON.stringify({ confidence: 'high' }),
        },
        { run_id: s.runId, kind: 'verify_report', body_md: 'The report', uri: null, data: null },
      ])
      .execute()
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    const record = JSON.parse((await call('get_decision')).text)
    expect(record.run).toEqual({
      number: 1,
      branch: 'feat/x',
      pull_request: { number: 7, url: 'https://github.com/owner/pay/pull/7' },
    })
    expect(record.spec).toMatchObject({ version: 1 })
    expect(record.spec.body_md).toContain('Retries back off')
    expect(record.plan).toBe('The plan')
    expect(record.verify_report).toMatchObject({ body_md: 'The report' })
  })

  it('returns a null plan and report when the run has none', async () => {
    const s = await seed(REVIEWED, 'pull_request', 'code_review')
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    const record = JSON.parse((await call('get_decision')).text)
    expect(record).toMatchObject({ plan: null, verify_report: null })
  })

  it('stores where, matters and the checkout’s commit and skipped files (AC15)', async () => {
    const s = await seed(REVIEWED, 'pull_request', 'code_review')
    const payload = {
      source: 'pull_request',
      fallback: false,
      commit: 'abc1234def',
      skipped: [
        { path: 'package-lock.json', skip: 'lockfile' },
        { path: 'dist/app.min.js', skip: 'generated' },
      ],
    }
    await sql`insert into events (id, run_id, ts, type, tool, payload)
        values (${crypto.randomUUID()}, ${s.helpRunId}, now(), 'tool_call', 'help_checkout',
          ${JSON.stringify(payload)}::jsonb)`.execute(db())
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    const saved = await call('save_help_result', {
      verdict: 'changes',
      findings: [
        {
          kind: 'bug',
          file: 'server/src/a.ts',
          line: 12,
          text: 'Off by one',
          matters: 'Loses a row',
        },
        { kind: 'test', file: 'server/src/b.ts', text: 'No test', matters: 'Regresses' },
      ],
      unsure: 'Nothing',
    })
    expect(saved.isError).toBe(false)
    const listed = (await app.inject({ url: `/api/tasks/${s.taskId}/helps` })).json()
    expect(listed[0].result).toEqual({
      mode: 'code_review',
      verdict: 'changes',
      findings: [
        { kind: 'bug', where: 'server/src/a.ts:12', text: 'Off by one', matters: 'Loses a row' },
        { kind: 'test', where: 'server/src/b.ts', text: 'No test', matters: 'Regresses' },
      ],
      unsure: 'Nothing',
      commit: 'abc1234def',
      skipped: payload.skipped,
    })
  })

  it('stores a null commit and no skipped files when no checkout event exists', async () => {
    const s = await seed(REVIEWED, 'pull_request', 'code_review')
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    await call('save_help_result', { verdict: 'nothing_to_change', unsure: 'u' })
    const listed = (await app.inject({ url: `/api/tasks/${s.taskId}/helps` })).json()
    expect(listed[0].result).toMatchObject({
      verdict: 'nothing_to_change',
      commit: null,
      skipped: [],
    })
  })
})
