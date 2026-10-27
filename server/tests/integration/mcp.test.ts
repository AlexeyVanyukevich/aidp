import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'
import { LIMITS } from '../../src/modules/approvals/approval-rules.js'
import { renderPlan } from '../../src/modules/mcp/plan-check.js'
import { GOOD_SPEC, seedProject, seedQueuedRun, seedTask } from './fixtures.js'

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

  it('offers the seven tools', async () => {
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
