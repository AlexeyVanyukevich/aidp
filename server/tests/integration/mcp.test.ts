import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'

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

  it('offers the six tools', async () => {
    const { client } = await session()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_spec',
      'get_task',
      'log_step',
      'request_approval',
      'save_plan',
      'save_report',
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
