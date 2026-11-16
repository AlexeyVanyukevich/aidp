import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerBoardTools } from '../../src/modules/mcp/board-tools.js'
import type { Block, Checkpoint, TaskState } from '../../src/shared/vocabulary.js'
import { lineDiff } from '../../src/modules/specs/line-diff.js'
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

  it('saves a review finding with choices, and refuses one choice', async () => {
    const s = await seed({ state: 'spec_review' }, 'spec_review', 'review')
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    const one = await call('save_help_result', {
      verdict: 'changes',
      findings: [{ kind: 'missing', where: 'R1', text: 'X', choices: ['A'], recommended: 0 }],
      unsure: 'u',
    })
    expect(one.text).toContain('findings: too few')
    expect(await statusOf('helps', s.helpId)).not.toBe('succeeded')
    const saved = await call('save_help_result', {
      verdict: 'changes',
      findings: [{ kind: 'missing', where: 'R1', text: 'X', choices: ['A', 'B'], recommended: 1 }],
      unsure: 'u',
    })
    expect(saved.isError).toBe(false)
    const listed = (await app.inject({ url: `/api/tasks/${s.taskId}/helps` })).json()
    expect(listed[0].result.findings).toEqual([
      { kind: 'missing', where: 'R1', text: 'X', choices: ['A', 'B'], recommended: 1 },
    ])
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

describe('get_decision: previous, for a spec review in review mode', () => {
  const numbered = (n: number, prefix = 'line') =>
    Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`)

  /** A spec review help whose subject is `version`; `bodies[k]` is the text of version k + 1. */
  async function reviewOn(bodies: string[], mode = 'review') {
    const s = await seed({ state: 'spec_review' }, 'spec_review', mode)
    await db()
      .updateTable('specs')
      .set({ body_md: bodies[0]! })
      .where('task_id', '=', s.taskId)
      .execute()
    for (const [k, body] of bodies.slice(1).entries())
      await db()
        .insertInto('specs')
        .values({
          task_id: s.taskId,
          version: k + 2,
          body_md: body,
          status: 'draft',
          criteria: null,
        })
        .execute()
    await db()
      .updateTable('helps')
      .set({ subject: JSON.stringify({ spec_version: bodies.length }) })
      .where('id', '=', s.helpId)
      .execute()
    return s
  }

  async function specRun(taskId: string, number: number, note: string | null) {
    return (
      await db()
        .insertInto('runs')
        .values({
          task_id: taskId,
          kind: 'spec',
          number,
          spec_version: null,
          note,
          status: 'succeeded',
          queued_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
  }

  const writtenBy = (taskId: string, version: number, runId: string | null) =>
    db()
      .updateTable('specs')
      .set({ run_id: runId })
      .where('task_id', '=', taskId)
      .where('version', '=', version)
      .execute()

  async function previousOf(s: { taskId: string; helpRunId: string; helpId: string }) {
    const call = await tools(s.taskId, s.helpRunId, s.helpId)
    const record = JSON.parse((await call('get_decision')).text) as Record<string, unknown>
    return { record, previous: record.previous as Record<string, any> | null }
  }

  it('is null for version 1', async () => {
    const s = await reviewOn([GOOD_SPEC])
    expect((await previousOf(s)).previous).toBeNull()
  })

  it('gives the line diff, not the text, for a small change', async () => {
    const v1 = numbered(12).join('\n')
    const v2 = numbered(12)
      .map((l) => (l === 'line 6' ? 'changed' : l))
      .join('\n')
    const s = await reviewOn([v1, v2])
    const { previous } = await previousOf(s)
    expect(previous!.version).toBe(1)
    expect(previous!.body_md).toBeNull()
    expect(previous!.diff).toBe(lineDiff(v1, v2))
    expect((previous!.diff as string).split('\n').filter((l) => l.startsWith('-line')).length).toBe(
      1,
    )
    expect(
      (previous!.diff as string).split('\n').filter((l) => l.startsWith('+changed')).length,
    ).toBe(1)
    expect((previous!.diff as string).length).toBeLessThan(v1.length)
  })

  it('gives the earlier text when the diff is over the cell limit', async () => {
    const v1 = numbered(1001, 'a').join('\n')
    const s = await reviewOn([v1, numbered(1001, 'b').join('\n')])
    const { previous } = await previousOf(s)
    expect(previous!.diff).toBeNull()
    expect(previous!.body_md).toBe(v1)
  })

  it('gives the earlier text when the diff is longer than it', async () => {
    const v1 = 'a\nb\nc'
    const s = await reviewOn([v1, 'x\ny\nz'])
    const { previous } = await previousOf(s)
    expect(lineDiff(v1, 'x\ny\nz')!.length).toBeGreaterThan(v1.length)
    expect(previous!.diff).toBeNull()
    expect(previous!.body_md).toBe(v1)
  })

  it('gives the note of the run that wrote the version', async () => {
    const s = await reviewOn([GOOD_SPEC, `${GOOD_SPEC}\n`])
    await writtenBy(s.taskId, 2, await specRun(s.taskId, 1, ' Drop R4 '))
    const { previous } = await previousOf(s)
    expect(previous!.note).toBe('Drop R4')
    expect('note_missing' in previous!).toBe(false)
  })

  it('says why there is no note for a version saved by hand', async () => {
    const s = await reviewOn([GOOD_SPEC, `${GOOD_SPEC}\n`])
    const { previous } = await previousOf(s)
    expect(previous!.note).toBeNull()
    expect(previous!.note_missing).toBe('saved by hand in the editor, so it has no redraft note')
  })

  it('says why there is no note for a run without one', async () => {
    const s = await reviewOn([GOOD_SPEC, `${GOOD_SPEC}\n`])
    await writtenBy(s.taskId, 2, await specRun(s.taskId, 1, '  '))
    const { previous } = await previousOf(s)
    expect(previous!.note).toBeNull()
    expect(previous!.note_missing).toBe('written by a spec run with no note')
  })

  describe('the newest earlier review', () => {
    const findings = [
      { kind: 'missing', where: 'R1', text: 'X', choices: ['A', 'B'], recommended: 1 },
    ]
    async function help(taskId: string, version: number, retired: boolean) {
      const run = await db()
        .insertInto('runs')
        .values({
          task_id: taskId,
          kind: 'help',
          number: 10 + version,
          status: 'succeeded',
          queued_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db()
        .insertInto('helps')
        .values({
          run_id: run.id,
          approval_id: null,
          decision: 'spec_review',
          subject: JSON.stringify({ spec_version: version }),
          question_index: null,
          mode: 'review',
          status: 'succeeded',
          result: JSON.stringify({
            mode: 'review',
            verdict: 'changes',
            findings,
            unsure: 'secret',
          }),
          reason: null,
          phase_id: null,
          runner_id: null,
          started_at: null,
          ended_at: null,
          last_heartbeat_at: null,
          created_at: new Date(),
          retired_at: retired ? new Date() : null,
        })
        .execute()
    }

    it('is given with its version, verdict and findings, without unsure', async () => {
      const s = await reviewOn([GOOD_SPEC, `${GOOD_SPEC}\n`, `${GOOD_SPEC}\n\n`])
      await help(s.taskId, 1, true)
      const { previous } = await previousOf(s)
      expect(previous!.earlier_review).toEqual({ version: 1, verdict: 'changes', findings })
      expect('unsure' in previous!.earlier_review).toBe(false)
    })

    it('is null without one', async () => {
      const s = await reviewOn([GOOD_SPEC, `${GOOD_SPEC}\n`])
      expect((await previousOf(s)).previous!.earlier_review).toBeNull()
    })
  })

  describe('the answers of the writing run', () => {
    async function ask(
      runId: string,
      row: {
        kind: 'question' | 'questions'
        status: 'answered' | 'expired'
        question?: string
        options?: unknown[]
        questions?: unknown[]
        answer: unknown
        at: number
      },
    ) {
      await db()
        .insertInto('approval_requests')
        .values({
          run_id: runId,
          phase_id: null,
          kind: row.kind,
          question: row.question ?? 'Q',
          options: JSON.stringify(row.options ?? []),
          recommendation: null,
          context_md: null,
          status: row.status,
          answer: JSON.stringify(row.answer),
          checkpoint: null,
          files: null,
          questions: row.questions === undefined ? null : JSON.stringify(row.questions),
          created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, row.at)),
          answered_at: row.status === 'answered' ? new Date() : null,
        })
        .execute()
    }
    const q = (id: string, question: string, options: { id: string; label: string }[] = []) => ({
      id,
      question,
      options,
      recommendation: null,
      context_md: null,
    })

    it('lists a batch in question order and skips an expired question', async () => {
      const s = await reviewOn([GOOD_SPEC, `${GOOD_SPEC}\n`])
      const run = await specRun(s.taskId, 1, 'n')
      await writtenBy(s.taskId, 2, run)
      await ask(run, {
        kind: 'questions',
        status: 'answered',
        at: 1,
        question: 'lead',
        questions: [q('q1', 'First?', [{ id: 'a', label: 'Alpha' }]), q('q2', 'Second?')],
        answer: {
          answers: [
            { question_id: 'q2', text: '  my words ' },
            { question_id: 'q1', option_id: 'a' },
          ],
        },
      })
      await ask(run, { kind: 'question', status: 'expired', at: 2, answer: null })
      const { previous } = await previousOf(s)
      expect(previous!.answers).toEqual([
        { question: 'First?', option: { id: 'a', label: 'Alpha' }, text: null },
        { question: 'Second?', option: null, text: 'my words' },
      ])
      expect(previous!.answers_left_out).toBe(0)
    })

    it('is empty without a writing run', async () => {
      const s = await reviewOn([GOOD_SPEC, `${GOOD_SPEC}\n`])
      const { previous } = await previousOf(s)
      expect(previous!.answers).toEqual([])
      expect(previous!.answers_left_out).toBe(0)
    })

    it('keeps the first entries under 4,000 characters and counts the rest', async () => {
      const s = await reviewOn([GOOD_SPEC, `${GOOD_SPEC}\n`])
      const run = await specRun(s.taskId, 1, 'n')
      await writtenBy(s.taskId, 2, run)
      for (const [k, word] of ['a', 'b', 'c'].entries())
        await ask(run, {
          kind: 'question',
          status: 'answered',
          at: k,
          question: `Q${k}`,
          answer: { text: word.repeat(1500) },
        })
      const { previous } = await previousOf(s)
      expect(previous!.answers.map((a: { question: string }) => a.question)).toEqual(['Q0', 'Q1'])
      expect(previous!.answers_left_out).toBe(1)
    })
  })

  it('is absent from a restate help, whose record keeps its shape', async () => {
    const s = await reviewOn([GOOD_SPEC, `${GOOD_SPEC}\n`], 'restate')
    const { record } = await previousOf(s)
    expect(Object.keys(record)).toEqual(['decision', 'mode', 'subject', 'task', 'spec', 'lint'])
    expect(record.spec).toEqual({ version: 2, body_md: `${GOOD_SPEC}\n` })
  })

  it('describes previous in the get_decision tool', async () => {
    const s = await reviewOn([GOOD_SPEC])
    const server = new McpServer({ name: 'board', version: '1.0.0' })
    registerBoardTools(server, {
      db: db(),
      runId: s.helpRunId,
      taskId: s.taskId,
      helpId: s.helpId,
      clock: () => new Date(),
    })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(b)
    const listed = await client.listTools()
    const text = listed.tools.find((t) => t.name === 'get_decision')!.description!
    for (const word of ['previous', 'note', 'answers', 'earlier review'])
      expect(text).toContain(word)
  })
})
