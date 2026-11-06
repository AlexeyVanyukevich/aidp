import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'
import { LIMITS } from '../../src/modules/approvals/approval-rules.js'
import { renderPlan } from '../../src/modules/mcp/plan-check.js'
import { GOOD_SPEC, seedProject, seedQueuedRun, seedTask, seedTitleRun } from './fixtures.js'

let app: FastifyInstance
let base: string

beforeAll(async () => {
  app = await buildTestApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const auth = { authorization: `Bearer ${TEST_RUNNER_KEY}` }

/** A claimed run with a running Plan phase, and an MCP client holding its token. */
async function session() {
  const seeded = await seedQueuedRun(getTestDb())
  await app.inject({
    method: 'POST',
    url: '/api/runner/claim',
    headers: auth,
    payload: { runner_id: 'r1' },
  })
  const token = (
    await app.inject({
      method: 'POST',
      url: `/api/runner/runs/${seeded.runId}/tokens`,
      headers: auth,
    })
  ).json().token as string
  const phaseId = crypto.randomUUID()
  await getTestDb()
    .insertInto('phases')
    .values({
      id: phaseId,
      run_id: seeded.runId,
      name: 'plan',
      attempt: 1,
      agent: 'planner',
      model: 'm',
      status: 'running',
      started_at: new Date(),
    })
    .execute()
  const client = new Client({ name: 'test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  // As in mcp.routes.ts: the SDK's class and interface disagree under exactOptionalPropertyTypes.
  await client.connect(transport as Transport)
  return { ...seeded, phaseId, client }
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n')

const PLAN = {
  summary: 'One step',
  confidence: 'high',
  steps: [{ title: 'Backoff', requirements: ['R1'], files: ['src/retry.ts'] }],
  checks: [{ criterion: 'AC1', how: 'unit test' }],
}

describe('the board MCP server', () => {
  it('refuses a request without a run token', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(response.status).toBe(401)
  })

  it('offers the eight tools', async () => {
    const { client } = await session()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_spec',
      'get_task',
      'log_step',
      'request_approval',
      'save_plan',
      'save_report',
      'save_spec',
      'suggest_title',
    ])
  })

  it('reads the task and its frozen spec', async () => {
    const { client } = await session()
    expect(
      JSON.parse(text(await client.callTool({ name: 'get_task', arguments: {} }))),
    ).toMatchObject({ key: 'PAY-1', title: 'Retry webhooks' })
    expect(
      JSON.parse(text(await client.callTool({ name: 'get_spec', arguments: {} }))),
    ).toMatchObject({ version: 1, requirements: ['R1'], criteria: [{ id: 'AC1' }] })
  })

  it('saves a plan that checks out, on the running phase', async () => {
    const { client, runId, phaseId } = await session()
    const result = await client.callTool({ name: 'save_plan', arguments: PLAN })
    expect(result.isError).toBeFalsy()
    const artifact = await getTestDb()
      .selectFrom('artifacts')
      .selectAll()
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(artifact).toMatchObject({ kind: 'plan', phase_id: phaseId, data: PLAN })
  })

  it('refuses a plan that leaves a criterion unchecked, saying which', async () => {
    const { client, runId } = await session()
    const result = await client.callTool({ name: 'save_plan', arguments: { ...PLAN, checks: [] } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('criterion_without_check AC1')
    expect(
      await getTestDb().selectFrom('artifacts').select('id').where('run_id', '=', runId).execute(),
    ).toEqual([])
  })

  /** The plan, its one check padded so that its rendered Markdown is `length` characters long. */
  const planOfLength = (length: number, confidence: 'high' | 'medium' = 'high') => {
    const base = { ...PLAN, confidence }
    const bare = renderPlan({ ...base, checks: [{ criterion: 'AC1', how: 'x' }] } as never).length
    return { ...base, checks: [{ criterion: 'AC1', how: 'x'.repeat(length - bare + 1) }] }
  }

  it('lists the plan length limit in the save_plan description', async () => {
    const { client } = await session()
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === 'save_plan')?.description).toContain('20,000')
  })

  it.each(['high', 'medium'] as const)(
    'refuses a plan too long to render at the gate, with %s confidence',
    async (confidence) => {
      const { client, runId } = await session()
      const plan = planOfLength(LIMITS.planContext + 1, confidence)
      const result = await client.callTool({ name: 'save_plan', arguments: plan })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(String(LIMITS.planContext + 1))
      expect(text(result)).toContain(String(LIMITS.planContext))
      expect(
        await getTestDb()
          .selectFrom('artifacts')
          .select('id')
          .where('run_id', '=', runId)
          .execute(),
      ).toEqual([])
    },
  )

  it('counts the escaped text of a check against the limit', async () => {
    const { client, runId } = await session()
    const plan = planOfLength(LIMITS.planContext)
    const piped = {
      ...plan,
      checks: [{ criterion: 'AC1', how: `${plan.checks[0]?.how.slice(1)}|` }],
    }
    const result = await client.callTool({ name: 'save_plan', arguments: piped })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(String(LIMITS.planContext + 1))
    expect(
      await getTestDb().selectFrom('artifacts').select('id').where('run_id', '=', runId).execute(),
    ).toEqual([])
  })

  it('saves a plan whose rendered text is exactly the limit', async () => {
    const { client, runId } = await session()
    const plan = planOfLength(LIMITS.planContext)
    expect(renderPlan(plan as never).length).toBe(LIMITS.planContext)
    const result = await client.callTool({ name: 'save_plan', arguments: plan })
    expect(text(result)).toBe('Plan saved.')
    expect(
      await getTestDb().selectFrom('artifacts').select('id').where('run_id', '=', runId).execute(),
    ).toHaveLength(1)
  })

  it('saves a verify report with a verdict on every criterion', async () => {
    const { client, runId } = await session()
    const report = {
      summary: 'Passed',
      criteria: [{ id: 'AC1', status: 'pass', evidence: 'test passes' }],
    }
    expect((await client.callTool({ name: 'save_report', arguments: report })).isError).toBeFalsy()
    const artifact = await getTestDb()
      .selectFrom('artifacts')
      .selectAll()
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(artifact).toMatchObject({ kind: 'verify_report', data: report })
  })

  it('lists the owner verdict in the save_report description', async () => {
    const { client } = await session()
    const { tools } = await client.listTools()
    const description = tools.find((t) => t.name === 'save_report')?.description ?? ''
    expect(description).toContain('owner')
    expect(description).toContain('fail when you can see the work is wrong')
    expect(description).toContain('never gets pass')
  })

  it('reads a stored criterion without an owner field as not an owner check', async () => {
    const { client } = await session()
    const report = { summary: 's', criteria: [{ id: 'AC1', status: 'owner', evidence: 'x' }] }
    const result = await client.callTool({ name: 'save_report', arguments: report })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('- owner_on_unmarked_criterion AC1')
  })

  it.each([
    ['pass', 'owner', undefined],
    ['fail', 'owner', undefined],
    ['pass', 'fail', undefined],
    ['fail', 'fail', undefined],
    ['owner', 'owner', '- owner_on_unmarked_criterion AC1'],
    ['pass', 'pass', '- pass_on_owner_check AC2'],
  ] as const)('save_report with AC1 %s and AC2 %s', async (a, b, refusal) => {
    const { client, runId, taskId } = await session()
    await getTestDb()
      .updateTable('specs')
      .set({
        criteria: JSON.stringify([
          { id: 'AC1', requirements: ['R1'], text: 'a', owner: false },
          { id: 'AC2', requirements: ['R1'], text: 'b', owner: true },
        ]),
      })
      .where('task_id', '=', taskId)
      .execute()
    const report = {
      summary: 's',
      criteria: [
        { id: 'AC1', status: a, evidence: 'x' },
        { id: 'AC2', status: b, evidence: 'x' },
      ],
    }
    const result = await client.callTool({ name: 'save_report', arguments: report })
    const saved = await getTestDb()
      .selectFrom('artifacts')
      .select('id')
      .where('run_id', '=', runId)
      .execute()
    if (refusal === undefined) {
      expect(result.isError).toBeFalsy()
      expect(saved).toHaveLength(1)
    } else {
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(refusal)
      expect(saved).toEqual([])
    }
  })

  it('logs a declared step as a message event of the phase agent', async () => {
    const { client, runId, phaseId } = await session()
    await client.callTool({
      name: 'log_step',
      arguments: { summary: 'Read the retry module', confidence: 'medium' },
    })
    const event = await getTestDb()
      .selectFrom('events')
      .selectAll()
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(event).toMatchObject({
      type: 'message',
      phase_id: phaseId,
      agent: 'planner',
      payload: { declared: true, summary: 'Read the retry module', confidence: 'medium' },
    })
  })
})

describe('withdrawn criteria', () => {
  const ANSWER = 'Drop AC2: the file is gone.'
  const WITHDRAWING = {
    summary: 'One step',
    confidence: 'medium',
    steps: [{ title: 'Backoff', requirements: ['R1'], files: ['src/retry.ts'] }],
    checks: [{ criterion: 'AC1', how: 'unit test' }],
    withdrawn: [{ criterion: 'AC2', answer: ANSWER }],
  }
  const stored = (runId: string, kind: 'plan' | 'verify_report') =>
    getTestDb()
      .selectFrom('artifacts')
      .selectAll()
      .where('run_id', '=', runId)
      .where('kind', '=', kind)
      .execute()

  /** A session whose spec has AC1 and AC2. */
  async function twoCriteria() {
    const seeded = await session()
    await getTestDb()
      .updateTable('specs')
      .set({
        criteria: JSON.stringify([
          { id: 'AC1', requirements: ['R1'], text: 'a' },
          { id: 'AC2', requirements: ['R1'], text: 'b' },
        ]),
      })
      .where('task_id', '=', seeded.taskId)
      .execute()
    return seeded
  }
  const gate = (runId: string, answer: { text?: string; option_id?: string }, contextMd = 'plan') =>
    getTestDb()
      .insertInto('approval_requests')
      .values({
        run_id: runId,
        kind: 'plan',
        question: 'Approve?',
        options: '[]',
        context_md: contextMd,
        status: 'answered',
        answer: JSON.stringify(answer),
        answered_at: new Date(),
      })
      .execute()
  const REPORT = {
    summary: 's',
    criteria: [
      { id: 'AC1', status: 'pass', evidence: 'x' },
      { id: 'AC2', status: 'withdrawn', evidence: 'the owner’s answer drops it' },
    ],
  }

  it('saves a plan that withdraws a criterion the owner dropped, and a plan without the list', async () => {
    const { client, runId } = await twoCriteria()
    await gate(runId, { text: ANSWER })
    expect(
      (await client.callTool({ name: 'save_plan', arguments: WITHDRAWING })).isError,
    ).toBeFalsy()
    const both = {
      ...WITHDRAWING,
      withdrawn: undefined,
      checks: [
        { criterion: 'AC1', how: 'a' },
        { criterion: 'AC2', how: 'b' },
      ],
    }
    expect((await client.callTool({ name: 'save_plan', arguments: both })).isError).toBeFalsy()
    const plans = await stored(runId, 'plan')
    expect(plans.map((a) => (a.data as { withdrawn: unknown }).withdrawn)).toEqual([
      WITHDRAWING.withdrawn,
      [],
    ])
    expect(plans[0]?.body_md).toContain(
      'Withdrawn by the owner:\n- AC2 — Drop AC2: the file is gone.',
    )
  })

  it('refuses words from another spec version, and accepts the run’s own gate', async () => {
    const { client, runId, taskId } = await twoCriteria()
    const other = await getTestDb()
      .insertInto('runs')
      .values({
        task_id: taskId,
        kind: 'delivery',
        number: 2,
        spec_version: 2,
        status: 'failed',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await gate(other.id, { text: ANSWER })
    const refused = await client.callTool({ name: 'save_plan', arguments: WITHDRAWING })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('withdrawn_answer_not_found AC2')
    expect(await stored(runId, 'plan')).toEqual([])
    await gate(runId, { text: `Please. ${ANSWER}` })
    expect(
      (await client.callTool({ name: 'save_plan', arguments: WITHDRAWING })).isError,
    ).toBeFalsy()
  })

  it('saves a withdrawn verdict only once the owner approved the plan, and records the answer', async () => {
    const { client, runId } = await twoCriteria()
    await gate(runId, { text: ANSWER })
    await client.callTool({ name: 'save_plan', arguments: WITHDRAWING })
    const refused = await client.callTool({ name: 'save_report', arguments: REPORT })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('withdrawn_not_in_plan AC2')
    expect(await stored(runId, 'verify_report')).toEqual([])
    const [plan] = await stored(runId, 'plan')
    await gate(runId, { option_id: 'approve' }, plan?.body_md)
    expect((await client.callTool({ name: 'save_report', arguments: REPORT })).isError).toBeFalsy()
    const [report] = await stored(runId, 'verify_report')
    expect((report?.data as { withdrawn: unknown }).withdrawn).toEqual([
      { criterion: 'AC2', answer: ANSWER },
    ])
    expect(report?.body_md).toContain('| AC2 | ⊘ withdrawn |')
  })

  it('records an empty withdrawn list on a report with no withdrawn verdict', async () => {
    const { client, runId } = await session()
    const report = { summary: 's', criteria: [{ id: 'AC1', status: 'pass', evidence: 'x' }] }
    await client.callTool({ name: 'save_report', arguments: report })
    const [saved] = await stored(runId, 'verify_report')
    expect((saved?.data as { withdrawn: unknown }).withdrawn).toEqual([])
  })

  it.each([
    [
      'save_plan',
      [
        'withdrawn',
        'changed criterion',
        'quotes the owner’s',
        'no row in the checks table',
        'never has confidence high',
      ],
    ],
    [
      'save_report',
      [
        'withdrawn',
        'Withdrawn by the owner',
        'plan-gate answers',
        'the owner’s answer',
        'never goes back to Build',
      ],
    ],
  ] as const)('describes the withdrawal in %s', async (tool, phrases) => {
    const { client } = await session()
    const { tools } = await client.listTools()
    const description = (tools.find((t) => t.name === tool)?.description ?? '').toLowerCase()
    for (const phrase of phrases) expect(description).toContain(phrase.toLowerCase())
    expect(description).not.toContain('every acceptance criterion gets a check')
  })
})

describe('request_approval', () => {
  const ask = {
    question: 'Which colour should the button be?',
    options: [
      { id: 'a', label: 'Red' },
      { id: 'b', label: 'Blue', impact: 'Matches the logo' },
    ],
    recommendation: 'b',
    context_md: 'The logo is blue.',
  }
  const PAUSED =
    'Paused: the owner will answer on the board, and the answer will arrive as your next message. End your turn now.'

  it('pauses the run on the agent’s question and tells it to stop', async () => {
    const { client, taskId, runId, phaseId } = await session()
    const result = await client.callTool({ name: 'request_approval', arguments: ask })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toBe(PAUSED)
    const approval = await getTestDb()
      .selectFrom('approval_requests')
      .select(['kind', 'phase_id', 'question', 'options', 'recommendation', 'status'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(approval).toEqual({
      kind: 'question',
      phase_id: phaseId,
      question: ask.question,
      options: ask.options,
      recommendation: 'b',
      status: 'open',
    })
    const task = await getTestDb()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
    expect(task.state).toBe('needs_approval')
  })

  it('gives an out-of-plan request the server’s options', async () => {
    const { client, runId } = await session()
    const result = await client.callTool({
      name: 'request_approval',
      arguments: {
        kind: 'out_of_plan',
        question: 'The fix needs the shared HTTP client.',
        files: ['src/http.ts'],
        options: [{ id: 'x', label: 'Let me' }],
      },
    })
    expect(text(result)).toBe(PAUSED)
    const approval = await getTestDb()
      .selectFrom('approval_requests')
      .select(['options', 'files'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(approval).toEqual({
      options: [
        { id: 'allow', label: 'Allow the change' },
        { id: 'refuse', label: 'Keep to the plan' },
      ],
      files: ['src/http.ts'],
    })
  })

  it('accepts a migration request with 20,000 characters of code', async () => {
    const { client, runId } = await session()
    const result = await client.callTool({
      name: 'request_approval',
      arguments: {
        kind: 'migration',
        question: 'Adds a column; down drops it.',
        files: ['server/src/db/migrations/004_x.ts'],
        context_md: 'x'.repeat(20_000),
        options: [{ id: 'x', label: 'Let me' }],
      },
    })
    expect(text(result)).toBe(PAUSED)
    const approval = await getTestDb()
      .selectFrom('approval_requests')
      .select(['options', 'files'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(approval.options).toEqual([
      { id: 'allow', label: 'Allow the migration' },
      { id: 'refuse', label: 'Keep to the plan' },
    ])
  })

  const MIGRATION = {
    kind: 'migration',
    question: 'Adds a column.',
    files: ['server/src/db/migrations/004_x.ts'],
    context_md: 'code',
  }
  it.each([
    ['no files', { ...MIGRATION, files: undefined }, /files/],
    ['two files', { ...MIGRATION, files: ['a/migrations/x.ts', 'a/migrations/y.ts'] }, /files/],
    ['an absolute path', { ...MIGRATION, files: ['/etc/x'] }, /files/],
    ['a blank question', { ...MIGRATION, question: ' ' }, /question/],
    ['blank code', { ...MIGRATION, context_md: ' ' }, /context_md/],
    ['too much code', { ...MIGRATION, context_md: 'x'.repeat(20_001) }, /context_md/],
    [
      'a fenced file',
      { ...MIGRATION, context_md: '```ts\nx\n```' },
      /context_md: fenced; send the raw file in context_md, without a Markdown code fence/,
    ],
  ])('refuses a migration request with %s, pausing nothing', async (_name, args, finding) => {
    const { client, runId } = await session()
    const result = await client.callTool({ name: 'request_approval', arguments: args })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(finding)
    const open = await getTestDb()
      .selectFrom('approval_requests')
      .select('id')
      .where('run_id', '=', runId)
      .execute()
    expect(open).toEqual([])
  })

  it('describes formatting before asking and a single Write after', async () => {
    const { client } = await session()
    const tools = await client.listTools()
    const description = tools.tools.find((tool) => tool.name === 'request_approval')?.description
    expect(description).toMatch(/format the file as the project’s formatter would/)
    expect(description).toMatch(/npx prettier --stdin-filepath/)
    expect(description).toMatch(/single Write/)
  })

  it.each([
    ['a recommendation naming no option', { ...ask, recommendation: 'z' }, /recommendation/],
    ['an out-of-plan request without files', { kind: 'out_of_plan', question: 'Can I?' }, /files/],
  ])('refuses %s, naming what is wrong', async (_name, args, finding) => {
    const { client } = await session()
    const result = await client.callTool({ name: 'request_approval', arguments: args })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(finding)
  })

  it('refuses a second question while the first waits, telling the agent to stop', async () => {
    const { client } = await session()
    await client.callTool({ name: 'request_approval', arguments: ask })
    const again = await client.callTool({ name: 'request_approval', arguments: ask })
    expect(again.isError).toBe(true)
    expect(text(again)).toBe('This run is already waiting for an answer. End your turn now.')
  })

  it('refuses a question when no phase of the run is running', async () => {
    const { client, phaseId } = await session()
    await getTestDb()
      .updateTable('phases')
      .set({ status: 'succeeded' })
      .where('id', '=', phaseId)
      .execute()
    const result = await client.callTool({ name: 'request_approval', arguments: ask })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('No phase of this run is running; nothing was asked.')
  })
})

/** An MCP client holding a token for a running spec run in its Spec phase, the card drafting. */
async function specSession(options: { versions?: number; phase?: 'running' | 'paused' } = {}) {
  const db = getTestDb()
  const { id: projectId } = await seedProject(db)
  const { id: taskId } = await seedTask(db, projectId, { state: 'spec_draft' })
  const versions = options.versions ?? 0
  for (let version = 1; version <= versions; version++)
    await db
      .insertInto('specs')
      .values({ task_id: taskId, version, body_md: `v${version}`, status: 'draft', criteria: null })
      .execute()
  const { id: runId } = await db
    .insertInto('runs')
    .values({
      task_id: taskId,
      kind: 'spec',
      number: 1,
      spec_version: versions === 0 ? null : versions,
      status: 'running',
      started_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await db
    .insertInto('phases')
    .values({
      id: crypto.randomUUID(),
      run_id: runId,
      name: 'spec',
      attempt: 1,
      agent: 'spec-writer',
      model: 'opus',
      status: options.phase ?? 'running',
      started_at: new Date(),
    })
    .execute()
  const token = (
    await app.inject({ method: 'POST', url: `/api/runner/runs/${runId}/tokens`, headers: auth })
  ).json().token as string
  const client = new Client({ name: 'test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport as Transport)
  return { taskId, runId, client }
}

const versions = (taskId: string) =>
  getTestDb()
    .selectFrom('specs')
    .select(['version', 'body_md', 'status', 'run_id'])
    .where('task_id', '=', taskId)
    .orderBy('version')
    .execute()
const saveSpec = (client: Client, body_md: string) =>
  client.callTool({ name: 'save_spec', arguments: { body_md } })

// Slice 3 spec §7: one version per draft, the lint in the reply, and no move of the card.
describe('save_spec', () => {
  it('saves the draft as the next version, supersedes the earlier one, and answers the lint', async () => {
    const { client, taskId, runId } = await specSession({ versions: 1 })
    const result = await saveSpec(client, GOOD_SPEC)
    expect(result.isError).toBeFalsy()
    expect(text(result)).toBe('Saved v2. Lint: clean.')
    expect(await versions(taskId)).toEqual([
      { version: 1, body_md: 'v1', status: 'superseded', run_id: null },
      { version: 2, body_md: GOOD_SPEC, status: 'draft', run_id: runId },
    ])
    const task = await getTestDb()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
    expect(task.state).toBe('spec_draft')
  })

  it('rewrites its own version on a second save, and names what the lint found', async () => {
    const { client, taskId } = await specSession()
    await saveSpec(client, '## Requirements\n')
    const result = await saveSpec(client, '## Requirements\n- It retries\n')
    expect(text(result)).toContain('Saved v1. It cannot be approved yet:')
    expect(text(result)).toContain('This requirement needs an id like R3: “It retries”.')
    expect(await versions(taskId)).toEqual([
      expect.objectContaining({ version: 1, body_md: '## Requirements\n- It retries\n' }),
    ])
  })

  it('names a prose line under Requirements', async () => {
    const { client } = await specSession()
    const result = await saveSpec(
      client,
      '## Requirements\n1. R1 – a\nIt also retries.\n\n## Acceptance criteria\n- AC1 (R1): Given x Then y\n',
    )
    expect(text(result)).toContain(
      'Under Requirements every line must be an item or indented under one: “It also retries.”.',
    )
  })

  it('refuses a delivery run, and saves nothing', async () => {
    const { client, taskId } = await session()
    const result = await saveSpec(client, GOOD_SPEC)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/spec run/)
    expect(await versions(taskId)).toHaveLength(1)
  })

  it('refuses a draft whose phase is not running', async () => {
    const { client, taskId } = await specSession({ phase: 'paused' })
    const result = await saveSpec(client, GOOD_SPEC)
    expect(result.isError).toBe(true)
    expect(await versions(taskId)).toEqual([])
  })

  it('refuses a spec over 50 000 characters', async () => {
    const { client, taskId } = await specSession()
    const result = await saveSpec(client, 'x'.repeat(50_001))
    expect(result.isError).toBe(true)
    expect(await versions(taskId)).toEqual([])
  })
})

describe('get_spec, in a spec run', () => {
  it('returns the latest version, the one a redraft starts from', async () => {
    const { client } = await specSession({ versions: 2 })
    expect(
      JSON.parse(text(await client.callTool({ name: 'get_spec', arguments: {} }))),
    ).toMatchObject({ version: 2, body_md: 'v2' })
  })

  it('says so when the task has no spec yet', async () => {
    const { client } = await specSession()
    expect(text(await client.callTool({ name: 'get_spec', arguments: {} }))).toBe(
      'This task has no spec yet.',
    )
  })
})

describe('request_approval with a batch', () => {
  it('numbers the questions, pauses the run, and tells the agent to stop', async () => {
    const { client, runId } = await session()
    const result = await client.callTool({
      name: 'request_approval',
      arguments: {
        kind: 'questions',
        questions: [
          {
            question: 'How often?',
            options: [{ id: 'three', label: 'Three times' }],
            recommendation: 'three',
          },
          { question: 'Which errors?' },
        ],
      },
    })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toMatch(/^Paused:/)
    const approval = await getTestDb()
      .selectFrom('approval_requests')
      .select(['kind', 'question', 'questions'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(approval).toMatchObject({
      kind: 'questions',
      question: '2 questions about the spec',
      questions: [{ id: 'q1' }, { id: 'q2' }],
    })
  })

  it('refuses a batch whose question names no option it offers, naming the field', async () => {
    const { client } = await session()
    const result = await client.callTool({
      name: 'request_approval',
      arguments: {
        kind: 'questions',
        questions: [{ question: 'How often?', recommendation: 'z' }],
      },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('questions[0].recommendation: unknown option')
  })
})

async function titleSession() {
  const project = await seedProject(getTestDb())
  const task = await seedTask(getTestDb(), project.id)
  const runId = await seedTitleRun(getTestDb(), task.id)
  await app.inject({
    method: 'POST',
    url: '/api/runner/claim',
    headers: auth,
    payload: { runner_id: 'r1', kinds: ['title'] },
  })
  const token = (
    await app.inject({ method: 'POST', url: `/api/runner/runs/${runId}/tokens`, headers: auth })
  ).json().token as string
  await getTestDb()
    .insertInto('phases')
    .values({
      id: crypto.randomUUID(),
      run_id: runId,
      name: 'title',
      attempt: 1,
      agent: 'title-writer',
      model: 'sonnet',
      status: 'running',
      started_at: new Date(),
    })
    .execute()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }) as Transport,
  )
  return { taskId: task.id, runId, client }
}
const suggest = (client: Client, title: string, reason = 'names drop_draft') =>
  client.callTool({ name: 'suggest_title', arguments: { title, reason } })
const titleArtifacts = (runId: string) =>
  getTestDb().selectFrom('artifacts').selectAll().where('run_id', '=', runId).execute()

describe('suggest_title', () => {
  it('stores one artifact and rewrites it on a second call, changing nothing else', async () => {
    const { client, runId, taskId } = await titleSession()
    const first = await suggest(client, 'First')
    expect(text(first)).toBe('Suggested: First')
    expect(text(await suggest(client, 'Second', 'other reason'))).toBe('Suggested: Second')
    const artifacts = await titleArtifacts(runId)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      kind: 'title',
      data: { title: 'Second', reason: 'other reason', decision: null },
    })
    const task = await getTestDb()
      .selectFrom('tasks')
      .select(['title', 'state'])
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
    expect(task).toEqual({ title: 'Retry webhooks', state: 'backlog' })
  })

  it('is refused for a delivery run', async () => {
    const { client, runId } = await session()
    const result = await suggest(client, 'T')
    expect(result.isError).toBe(true)
    expect(await titleArtifacts(runId)).toEqual([])
  })

  it('refuses a blank title and names the field, storing nothing', async () => {
    const { client, runId } = await titleSession()
    const result = await suggest(client, '  ')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('title: must not be blank')
    expect(await titleArtifacts(runId)).toEqual([])
  })
})
