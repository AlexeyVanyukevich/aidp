import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'
import { GOOD_SPEC, seedProject, seedQueuedRun, seedRunningRun, seedTask } from './fixtures.js'
import { openApproval } from '../../src/modules/approvals/approval.service.js'
import { publish } from '../../src/shared/bus.js'

let app: FastifyInstance
let now = new Date('2026-10-11T10:00:00Z')
const auth = { authorization: `Bearer ${TEST_RUNNER_KEY}` }

beforeAll(async () => {
  app = await buildTestApp({ clock: () => now })
})
beforeEach(async () => {
  await resetDb()
  now = new Date('2026-10-11T10:00:00Z')
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const claim = (wait_ms = 0) =>
  app.inject({
    method: 'POST',
    url: '/api/runner/claim',
    headers: auth,
    payload: { runner_id: 'r1', wait_ms },
  })

async function claimed() {
  const seeded = await seedQueuedRun(getTestDb())
  await claim()
  const token = (
    await app.inject({
      method: 'POST',
      url: `/api/runner/runs/${seeded.runId}/tokens`,
      headers: auth,
    })
  ).json().token as string
  return { ...seeded, token }
}

function event(
  runId: string,
  type: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id: crypto.randomUUID(),
    run_id: runId,
    phase_id: null,
    ts: now.toISOString(),
    type,
    agent: null,
    model: null,
    tool: null,
    target: null,
    status: null,
    duration_ms: null,
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    payload,
    ...extra,
  }
}

const send = (token: string, events: unknown[]) =>
  app.inject({
    method: 'POST',
    url: '/api/runner/events',
    headers: { authorization: `Bearer ${token}` },
    payload: { events },
  })

const state = async (taskId: string) =>
  (
    await getTestDb()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
  ).state

describe('the runner key', () => {
  it.each([
    ['no header', {}],
    ['the wrong key', { authorization: `Bearer ${'x'.repeat(40)}` }],
    ['another scheme', { authorization: `Basic ${TEST_RUNNER_KEY}` }],
  ])('answers %s with one identical 401', async (_name, headers) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/runner/claim',
      headers,
      payload: { runner_id: 'r1' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: 'unauthorized',
      message: 'Missing or invalid credential',
    })
  })

  // The credential is checked before the body is read: a caller without one learns nothing of
  // the body's shape, whatever it sends.
  const RUN = '00000000-0000-4000-8000-000000000001'
  const routes = [
    '/api/runner/claim',
    '/api/runner/heartbeat',
    `/api/runner/runs/${RUN}/tokens`,
    '/api/runner/events',
    '/api/runner/tokens/retire',
  ]
  const credentials: [string, Record<string, string>][] = [
    ['no header', {}],
    ['a wrong secret', { authorization: `Bearer ${'x'.repeat(40)}` }],
  ]
  it.each(
    routes.flatMap((url) => credentials.map(([name, headers]) => [url, name, headers] as const)),
  )('answers %s with %s and an empty body with the same 401', async (url, _name, headers) => {
    const response = await app.inject({ method: 'POST', url, headers, payload: {} })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: 'unauthorized',
      message: 'Missing or invalid credential',
    })
  })
})

describe('POST /api/runner/claim', () => {
  it('answers no work when nothing is queued', async () => {
    expect((await claim()).json()).toEqual({ work: null })
  })

  it('hands over the oldest queued run with everything the runner needs, once', async () => {
    const { taskId, runId } = await seedQueuedRun(getTestDb())
    const work = (await claim()).json().work
    expect(work).toMatchObject({
      kind: 'start',
      run: {
        id: runId,
        number: 1,
        kind: 'delivery',
        spec_version: 1,
        task: { id: taskId, key: 'PAY-1', title: 'Retry webhooks', budget_usd: null },
        spec: { version: 1, criteria: [{ id: 'AC1' }] },
        project: {
          key: 'PAY',
          repo_path: '/repos/PAY',
          github_repo: 'owner/pay',
          base_branch: 'main',
          test_command: 'npm test',
        },
      },
    })
    expect(await state(taskId)).toBe('running')
    expect((await claim()).json()).toEqual({ work: null })
  })

  it('numbers the run among the task’s delivery runs, not its drafts', async () => {
    const { taskId } = await seedQueuedRun(getTestDb())
    await getTestDb()
      .insertInto('runs')
      .values({
        task_id: taskId,
        kind: 'spec',
        number: 1,
        spec_version: null,
        status: 'succeeded',
        created_at: new Date('2026-01-01T00:00:00Z'),
      })
      .execute()
    expect((await claim()).json().work.run.number).toBe(1)
  })

  it('waits for work when asked to, and answers as soon as a run is queued', async () => {
    const pending = claim(5_000)
    await new Promise((done) => setTimeout(done, 200))
    // Seeded directly, so the test publishes what Task 10's queueDeliveryRun publishes.
    const { runId } = await seedQueuedRun(getTestDb())
    await publish(getTestDb(), { topic: 'run.queued', runId })
    expect((await pending).json().work.run.id).toBe(runId)
  })

  it('cancels a queued run whose task was cancelled, instead of handing it over', async () => {
    const { runId } = await seedQueuedRun(getTestDb(), { state: 'failed' })
    expect((await claim()).json()).toEqual({ work: null })
    const run = await getTestDb()
      .selectFrom('runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run.status).toBe('cancelled')
  })
})

describe('run tokens', () => {
  it('accept events for their own run', async () => {
    const { runId, token } = await claimed()
    expect((await send(token, [event(runId, 'message', {})])).json()).toEqual({ accepted: 1 })
  })

  it('refuse events for another run', async () => {
    const { token } = await claimed()
    const response = await send(token, [event(crypto.randomUUID(), 'message', {})])
    expect(response.statusCode).toBe(401)
  })

  it('expire twelve hours after issue', async () => {
    const { runId, token } = await claimed()
    now = new Date(now.getTime() + 12 * 3600_000 + 1)
    expect((await send(token, [event(runId, 'message', {})])).statusCode).toBe(401)
  })

  it('stop working five minutes after they are retired', async () => {
    const { runId, token } = await claimed()
    const retired = await app.inject({
      method: 'POST',
      url: '/api/runner/tokens/retire',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(retired.statusCode).toBe(204)
    now = new Date(now.getTime() + 4 * 60_000)
    expect((await send(token, [event(runId, 'message', {})])).statusCode).toBe(200)
    now = new Date(now.getTime() + 2 * 60_000)
    expect((await send(token, [event(runId, 'message', {})])).statusCode).toBe(401)
  })

  it('are issued only for a run that is running', async () => {
    const { runId } = await seedQueuedRun(getTestDb())
    const response = await app.inject({
      method: 'POST',
      url: `/api/runner/runs/${runId}/tokens`,
      headers: auth,
    })
    expect(response.statusCode).toBe(409)
  })
})

describe('POST /api/runner/events', () => {
  it('records a phase from its start and end events, with usage on the events', async () => {
    const { runId, token } = await claimed()
    const phaseId = crypto.randomUUID()
    await send(token, [
      event(
        runId,
        'phase_start',
        { name: 'plan', attempt: 1, session_id: crypto.randomUUID() },
        { phase_id: phaseId, agent: 'planner', model: 'm' },
      ),
      event(
        runId,
        'message',
        {},
        {
          phase_id: phaseId,
          agent: 'planner',
          model: 'm',
          usage: { input: 10, output: 20, cache_read: 30, cache_write: 40 },
        },
      ),
      event(
        runId,
        'phase_end',
        { status: 'succeeded', summary_md: 'Planned', reported_cost: { m: 0.01 } },
        { phase_id: phaseId },
      ),
    ])
    const phase = await getTestDb()
      .selectFrom('phases')
      .selectAll()
      .where('id', '=', phaseId)
      .executeTakeFirstOrThrow()
    expect(phase).toMatchObject({
      name: 'plan',
      attempt: 1,
      status: 'succeeded',
      summary_md: 'Planned',
      reported_cost: { m: 0.01 },
    })
    const run = await getTestDb()
      .selectFrom('runs')
      .select('current_phase')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run.current_phase).toBe('plan')
  })

  // Ajv's default type coercion turned a null in a `string | null` field into "" and a null
  // duration into 0; found by the first smoke run, 2026-10-18.
  it('stores the fields an event leaves null as null', async () => {
    const { runId, token } = await claimed()
    const sent = event(runId, 'tool_call', {}, { agent: 'runner', tool: 'test_command' })
    expect((await send(token, [sent])).json()).toEqual({ accepted: 1 })
    const row = await getTestDb()
      .selectFrom('events')
      .select(['model', 'target', 'status', 'duration_ms', 'phase_id'])
      .where('id', '=', sent.id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({
      model: null,
      target: null,
      status: null,
      duration_ms: null,
      phase_id: null,
    })
  })

  // Review Focus 3: a replay after the server was down counts each event once.
  it('ignores a replayed event', async () => {
    const { runId, token } = await claimed()
    const same = event(
      runId,
      'message',
      {},
      { model: 'm', usage: { input: 5, output: 0, cache_read: 0, cache_write: 0 } },
    )
    expect((await send(token, [same])).json()).toEqual({ accepted: 1 })
    expect((await send(token, [same])).json()).toEqual({ accepted: 0 })
    const rows = await getTestDb()
      .selectFrom('events')
      .select('input')
      .where('run_id', '=', runId)
      .execute()
    expect(rows).toEqual([{ input: 5 }])
  })

  it('moves the card to Review and records the pull request', async () => {
    const { runId, taskId, token } = await claimed()
    const announced = app.bus.next('run.event', 5_000)
    await send(token, [
      event(runId, 'run_end', {
        outcome: 'review',
        pr_number: 7,
        pr_url: 'https://github.com/owner/pay/pull/7',
        branch: 'board/PAY-1-r1',
      }),
    ])
    expect(await state(taskId)).toBe('review')
    const run = await getTestDb()
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run).toMatchObject({ status: 'succeeded', pr_number: 7, branch: 'board/PAY-1-r1' })
    const artifact = await getTestDb()
      .selectFrom('artifacts')
      .selectAll()
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(artifact).toMatchObject({ kind: 'pr', uri: 'https://github.com/owner/pay/pull/7' })
    expect(await announced).toEqual({ topic: 'run.event', runId, taskId })
  })

  it('moves the card to Failed with the reason', async () => {
    const { runId, taskId, token } = await claimed()
    await send(token, [
      event(runId, 'run_end', { outcome: 'failed', reason: 'verify failed three times' }),
    ])
    expect(await state(taskId)).toBe('failed')
    const run = await getTestDb()
      .selectFrom('runs')
      .select(['status', 'failure_reason'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run).toEqual({ status: 'failed', failure_reason: 'verify failed three times' })
  })

  it('accepts a failure report for a card the owner already cancelled', async () => {
    const { runId, taskId, token } = await claimed()
    await getTestDb()
      .updateTable('tasks')
      .set({ state: 'failed' })
      .where('id', '=', taskId)
      .execute()
    const response = await send(token, [
      event(runId, 'run_end', { outcome: 'cancelled', reason: 'cancelled by the owner' }),
    ])
    expect(response.statusCode).toBe(200)
    expect(await state(taskId)).toBe('failed')
  })

  it('refuses a malformed phase event without storing any of the batch', async () => {
    const { runId, token } = await claimed()
    const response = await send(token, [
      event(runId, 'message', {}),
      event(
        runId,
        'phase_start',
        { name: 'deploy', attempt: 1 },
        { phase_id: crypto.randomUUID(), agent: 'a', model: 'm' },
      ),
    ])
    expect(response.statusCode).toBe(400)
    const rows = await getTestDb()
      .selectFrom('events')
      .select('id')
      .where('run_id', '=', runId)
      .execute()
    expect(rows).toEqual([])
  })
})

describe('POST /api/runner/heartbeat', () => {
  it('records liveness and hands back the runs the owner cancelled', async () => {
    const { runId } = await claimed()
    await getTestDb()
      .updateTable('runs')
      .set({ cancel_requested: true })
      .where('id', '=', runId)
      .execute()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runner/heartbeat',
      headers: auth,
      payload: { runner_id: 'r1', run_ids: [runId] },
    })
    expect(response.json()).toEqual({ cancel: [runId], pause: [] })
    const run = await getTestDb()
      .selectFrom('runs')
      .select('last_heartbeat_at')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run.last_heartbeat_at).toEqual(now)
  })
})

const db = () => getTestDb()
const at = (seconds: number) => new Date(now.getTime() + seconds * 1_000)
const CHECKPOINT = (phaseId: string, sessionId: string) => ({
  stage: 'build',
  attempt: 1,
  phase_id: phaseId,
  session: { id: sessionId, baseline: {}, reported: {} },
  head: 'abc123',
  plan_artifact_id: null,
  failing_report_id: null,
})

/** A run paused and answered: queued to resume, as the approvals service leaves it. */
async function queuedResume(projectKey = 'PAY', queuedAt = at(1)) {
  const run = await seedRunningRun(db(), { projectKey })
  await db()
    .updateTable('runs')
    .set({
      status: 'queued',
      pending: 'resume',
      queued_at: queuedAt,
      resume_message: 'The owner answered your question:\n\nBlue',
      checkpoint: JSON.stringify(CHECKPOINT(run.phaseId, run.sessionId)),
    })
    .where('id', '=', run.runId)
    .execute()
  await db().updateTable('phases').set({ status: 'paused' }).where('id', '=', run.phaseId).execute()
  return run
}

/** A run cancelled while paused, its worktree still on disk. */
async function queuedCleanup(projectKey = 'PAY', queuedAt = at(1)) {
  const run = await seedRunningRun(db(), { projectKey })
  await db()
    .updateTable('runs')
    .set({ status: 'cancelled', pending: 'cleanup', queued_at: queuedAt, worktree_path: '/wt/x' })
    .where('id', '=', run.runId)
    .execute()
  return run
}

const runRow = (id: string) =>
  db().selectFrom('runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

describe('claiming resumes and cleanups', () => {
  it('hands over a resume with its checkpoint, message and allowed files; the card stays Running', async () => {
    const { runId, taskId, phaseId, sessionId } = await queuedResume()
    await db()
      .insertInto('artifacts')
      .values({
        run_id: runId,
        phase_id: null,
        kind: 'plan',
        body_md: 'plan',
        uri: null,
        data: JSON.stringify({
          steps: [{ files: ['src/a.ts'] }, { files: ['src/a.ts', 'src/c.ts'] }],
        }),
      })
      .execute()
    await db()
      .insertInto('approval_requests')
      .values({
        run_id: runId,
        phase_id: phaseId,
        kind: 'out_of_plan',
        question: 'May I?',
        options: '[]',
        recommendation: null,
        context_md: null,
        status: 'answered',
        answer: JSON.stringify({ option_id: 'allow' }),
        checkpoint: null,
        files: JSON.stringify(['src/b.ts']),
        answered_at: now,
      })
      .execute()

    const work = (await claim()).json().work
    expect(work).toMatchObject({
      kind: 'resume',
      run: { id: runId, task: { key: 'PAY-1' }, project: { key: 'PAY' } },
      checkpoint: CHECKPOINT(phaseId, sessionId),
      message: 'The owner answered your question:\n\nBlue',
      allowed_files: ['src/a.ts', 'src/c.ts', 'src/b.ts'],
    })
    expect(await state(taskId)).toBe('running')
    expect(await runRow(runId)).toMatchObject({
      status: 'running',
      pending: null,
      queued_at: null,
      runner_id: 'r1',
      last_heartbeat_at: now,
    })
    expect((await claim()).json()).toEqual({ work: null })
  })

  it('hands over the approved migrations, also as allowed files; a refused one is in neither', async () => {
    const { runId, phaseId } = await queuedResume()
    const ask = (path: string, option_id: string) =>
      db()
        .insertInto('approval_requests')
        .values({
          run_id: runId,
          phase_id: phaseId,
          kind: 'migration',
          question: 'Adds a column.',
          options: '[]',
          recommendation: null,
          context_md: 'code',
          status: 'answered',
          answer: JSON.stringify({ option_id }),
          checkpoint: null,
          files: JSON.stringify([path]),
          answered_at: now,
        })
        .execute()
    await ask('server/src/db/migrations/004_x.ts', 'allow')
    await ask('server/src/db/migrations/005_y.ts', 'refuse')
    const work = (await claim()).json().work
    expect(work.approved_migrations).toEqual(['server/src/db/migrations/004_x.ts'])
    expect(work.allowed_files).toEqual(['server/src/db/migrations/004_x.ts'])
  })

  it('derives a checkpoint from the records when the runner never sent one', async () => {
    const { runId, phaseId, sessionId } = await queuedResume()
    await db().updateTable('runs').set({ checkpoint: null }).where('id', '=', runId).execute()
    expect((await claim()).json().work.checkpoint).toEqual({
      stage: 'build',
      attempt: 1,
      phase_id: phaseId,
      session: { id: sessionId, baseline: {}, reported: {} },
      head: null,
      plan_artifact_id: null,
      failing_report_id: null,
    })
  })

  it('hands over a cleanup with what the runner needs to remove the worktree', async () => {
    const { runId } = await queuedCleanup()
    expect((await claim()).json().work).toEqual({
      kind: 'cleanup',
      run: { id: runId, repo_path: '/repos/PAY', worktree_path: '/wt/x' },
    })
    expect(await runRow(runId)).toMatchObject({
      status: 'cancelled',
      pending: null,
      queued_at: null,
    })
  })

  it('hands over work oldest first, whatever its kind', async () => {
    const start = await seedQueuedRun(db(), { projectKey: 'ONE' })
    await db()
      .updateTable('runs')
      .set({ queued_at: at(2) })
      .where('id', '=', start.runId)
      .execute()
    await queuedResume('TWO', at(1))
    await queuedCleanup('THREE', at(3))
    const kinds = []
    for (let n = 0; n < 3; n++) kinds.push((await claim()).json().work.kind)
    expect(kinds).toEqual(['resume', 'start', 'cleanup'])
  })

  it('wakes a waiting claim as soon as the owner answers', async () => {
    const run = await seedRunningRun(db())
    const { id } = await db()
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
            options: [{ id: 'a', label: 'Red' }],
          },
          now,
          { recordEvent: true },
        ),
      )
    const started = Date.now()
    const waiting = claim(5_000)
    await new Promise((done) => setTimeout(done, 200))
    await app.inject({
      method: 'POST',
      url: `/api/approvals/${id}/answer`,
      payload: { option_id: 'a' },
    })
    expect((await waiting).json().work).toMatchObject({ kind: 'resume', run: { id: run.runId } })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('takes a skipped start off the queue', async () => {
    const { runId } = await seedQueuedRun(db(), { state: 'failed' })
    await claim()
    expect(await runRow(runId)).toMatchObject({ status: 'cancelled', queued_at: null })
  })
})

describe('the heartbeat’s answer', () => {
  const beat = (runIds: string[], runner = 'r1') =>
    app.inject({
      method: 'POST',
      url: '/api/runner/heartbeat',
      headers: auth,
      payload: { runner_id: runner, run_ids: runIds },
    })

  it.each([
    {
      name: 'a paused run of this runner is to pause',
      status: 'paused',
      owner: 'r1',
      cancel: false,
      pause: true,
    },
    {
      name: 'a running run of this runner goes on',
      status: 'running',
      owner: 'r1',
      cancel: false,
      pause: false,
    },
    {
      name: 'a blocked run is to stop',
      status: 'blocked',
      owner: 'r1',
      cancel: true,
      pause: false,
    },
    {
      name: 'a cancelled run is to stop',
      status: 'cancelled',
      owner: 'r1',
      cancel: true,
      pause: false,
    },
    {
      name: 'another runner’s run is to stop',
      status: 'running',
      owner: 'r2',
      cancel: true,
      pause: false,
    },
  ] as const)('$name', async ({ status, owner, cancel, pause }) => {
    const { runId } = await seedRunningRun(db())
    await db()
      .updateTable('runs')
      .set({ status, runner_id: owner })
      .where('id', '=', runId)
      .execute()
    expect((await beat([runId])).json()).toEqual({
      cancel: cancel ? [runId] : [],
      pause: pause ? [runId] : [],
    })
  })
})

describe('events that pause, block and resume', () => {
  const S1 = '00000000-0000-4000-8000-0000000000c1'
  const S2 = '00000000-0000-4000-8000-0000000000c2'
  async function running() {
    const seeded = await claimed()
    const phaseId = crypto.randomUUID()
    const started = await send(seeded.token, [
      event(
        seeded.runId,
        'phase_start',
        { name: 'build', attempt: 1, session_id: S1 },
        { phase_id: phaseId, agent: 'builder', model: 'sonnet' },
      ),
    ])
    expect(started.json()).toEqual({ accepted: 1 })
    return { ...seeded, phaseId }
  }
  const phase = (id: string) =>
    db().selectFrom('phases').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

  it('keeps the latest checkpoint on the run', async () => {
    const { runId, token, phaseId } = await running()
    const checkpoint = CHECKPOINT(phaseId, S1)
    expect((await send(token, [event(runId, 'checkpoint', checkpoint)])).statusCode).toBe(200)
    expect((await runRow(runId)).checkpoint).toEqual(checkpoint)
  })

  it('blocks the run and the card on a failed step, pausing the phase', async () => {
    const { runId, taskId, token, phaseId } = await running()
    const block = { cause: 'step_failed', stage: 'push', command: 'git push', output: 'rejected' }
    await send(token, [event(runId, 'error', { blocks: true, ...block })])
    expect(await runRow(runId)).toMatchObject({ status: 'blocked', block })
    expect(await state(taskId)).toBe('blocked')
    expect((await phase(phaseId)).status).toBe('paused')
  })

  it('records a block on a card the owner already moved, moving nothing', async () => {
    const { runId, taskId, token } = await running()
    await db().updateTable('tasks').set({ state: 'failed' }).where('id', '=', taskId).execute()
    await send(token, [
      event(runId, 'error', { blocks: true, cause: 'runner_stopped', stage: 'build' }),
    ])
    expect(await state(taskId)).toBe('failed')
    expect((await runRow(runId)).block).toEqual({ cause: 'runner_stopped', stage: 'build' })
  })

  it('runs a paused phase again on a resumed start, with its new session', async () => {
    const { runId, token, phaseId } = await running()
    await db().updateTable('phases').set({ status: 'paused' }).where('id', '=', phaseId).execute()
    await send(token, [
      event(
        runId,
        'phase_start',
        { name: 'build', attempt: 1, session_id: S2, resumed: true },
        { phase_id: phaseId, agent: 'builder', model: 'sonnet' },
      ),
    ])
    expect(await phase(phaseId)).toMatchObject({ status: 'running', session_id: S2 })
  })

  it('marks a phase interrupted when its end says so', async () => {
    const { runId, token, phaseId } = await running()
    await send(token, [
      event(runId, 'phase_end', { status: 'succeeded', interrupted: true }, { phase_id: phaseId }),
    ])
    expect((await phase(phaseId)).interrupted).toBe(true)
  })

  it('opens the plan gate’s approval once, however often the event arrives', async () => {
    const { runId, taskId, token, phaseId } = await running()
    const approvalId = '00000000-0000-4000-8000-0000000000bb'
    const gate = event(
      runId,
      'approval_requested',
      { approval_id: approvalId, kind: 'plan', question: 'Approve this plan?', context_md: '1. x' },
      { phase_id: phaseId },
    )
    await send(token, [gate])
    await send(token, [gate])
    const approvals = await db().selectFrom('approval_requests').selectAll().execute()
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      id: approvalId,
      kind: 'plan',
      options: [{ id: 'approve', label: 'Approve plan' }],
      context_md: '1. x',
    })
    expect(await state(taskId)).toBe('needs_approval')
  })

  it('opens a plan gate whose context is 8 343 characters, whole', async () => {
    const { runId, token, phaseId } = await running()
    const context = 'p'.repeat(8343)
    const response = await send(token, [
      event(
        runId,
        'approval_requested',
        {
          approval_id: '00000000-0000-4000-8000-0000000000bc',
          kind: 'plan',
          question: 'Approve this plan?',
          context_md: context,
        },
        { phase_id: phaseId },
      ),
    ])
    expect(response.statusCode).toBe(200)
    const approval = await db()
      .selectFrom('approval_requests')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(approval.context_md).toBe(context)
  })
})

// Slice 3: spec runs, handed out by the claim and settled by their events (spec §4, §5).
const act = (taskId: string, action: string, payload?: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/actions/${action}`,
    ...(payload === undefined ? {} : { payload }),
  })

/** A Backlog task with a description and, when asked, a version already saved. */
async function draftable(versions = 0) {
  const { id: projectId } = await seedProject(getTestDb())
  const { id: taskId } = await seedTask(getTestDb(), projectId)
  await getTestDb()
    .updateTable('tasks')
    .set({ description_md: 'Retry failed webhooks.' })
    .where('id', '=', taskId)
    .execute()
  for (let version = 1; version <= versions; version++)
    await getTestDb()
      .insertInto('specs')
      .values({ task_id: taskId, version, body_md: GOOD_SPEC, status: 'draft', criteria: null })
      .execute()
  if (versions > 0)
    await getTestDb()
      .updateTable('tasks')
      .set({ state: 'spec_review' })
      .where('id', '=', taskId)
      .execute()
  return taskId
}

/** A spec run claimed and running, with its token: a first draft, or a redraft of v1. */
async function drafting(redraft = false) {
  const taskId = await draftable(redraft ? 1 : 0)
  if (redraft) await act(taskId, 'redraft', { note: 'Say how long.' })
  else await act(taskId, 'draft-spec')
  const work = (await claim()).json().work
  const token = (
    await app.inject({
      method: 'POST',
      url: `/api/runner/runs/${work.run.id}/tokens`,
      headers: auth,
    })
  ).json().token as string
  return { taskId, runId: work.run.id as string, token, work }
}

const runEnd = (runId: string, outcome: string, reason?: string) =>
  event(runId, 'run_end', { outcome, ...(reason === undefined ? {} : { reason }) })

const saveVersion = (taskId: string, runId: string) =>
  getTestDb()
    .insertInto('specs')
    .values({
      task_id: taskId,
      version: 9,
      body_md: GOOD_SPEC,
      status: 'draft',
      criteria: null,
      run_id: runId,
    })
    .execute()

describe('a spec run', () => {
  it('is handed out as a first draft, leaving the card in Spec draft', async () => {
    const { taskId, work } = await drafting()
    expect(work).toMatchObject({
      kind: 'start',
      run: {
        kind: 'spec',
        number: 1,
        spec_version: null,
        spec: null,
        note: null,
        task: { id: taskId, key: 'PAY-1', description_md: 'Retry failed webhooks.' },
        project: { key: 'PAY', base_branch: 'main' },
      },
    })
    expect(await state(taskId)).toBe('spec_draft')
  })

  it('is handed out as a redraft, with the version it redrafts and the note', async () => {
    const { work } = await drafting(true)
    expect(work.run).toMatchObject({
      kind: 'spec',
      spec_version: 1,
      spec: { version: 1, body_md: GOOD_SPEC },
      note: 'Say how long.',
    })
  })

  it('is skipped and cancelled when its card has left Spec draft before the claim', async () => {
    const taskId = await draftable()
    await act(taskId, 'draft-spec')
    await getTestDb()
      .updateTable('tasks')
      .set({ state: 'backlog' })
      .where('id', '=', taskId)
      .execute()
    expect((await claim()).json()).toEqual({ work: null })
    const run = await getTestDb()
      .selectFrom('runs')
      .select('status')
      .where('task_id', '=', taskId)
      .executeTakeFirstOrThrow()
    expect(run.status).toBe('cancelled')
  })

  it('moves its card to Spec review when it ends with a saved version', async () => {
    const { taskId, runId, token } = await drafting()
    await saveVersion(taskId, runId)
    expect((await send(token, [runEnd(runId, 'drafted')])).statusCode).toBe(200)
    expect(await state(taskId)).toBe('spec_review')
    const run = await getTestDb()
      .selectFrom('runs')
      .select(['status', 'failure_reason'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run).toEqual({ status: 'succeeded', failure_reason: null })
  })

  it('fails, and returns its card to Backlog, when it ends without saving one', async () => {
    const { taskId, runId, token } = await drafting()
    await send(token, [runEnd(runId, 'drafted')])
    expect(await state(taskId)).toBe('backlog')
    const run = await getTestDb()
      .selectFrom('runs')
      .select(['status', 'failure_reason'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run).toEqual({ status: 'failed', failure_reason: 'the spec-writer saved no spec' })
  })

  it('returns a redraft that failed to Spec review', async () => {
    const { taskId, runId, token } = await drafting(true)
    await send(token, [runEnd(runId, 'failed', 'the spec phase failed')])
    expect(await state(taskId)).toBe('spec_review')
  })

  it('pauses on a question and drafts again on the answer', async () => {
    const { taskId, runId } = await drafting()
    const phaseId = crypto.randomUUID()
    await getTestDb()
      .insertInto('phases')
      .values({
        id: phaseId,
        run_id: runId,
        name: 'spec',
        attempt: 1,
        agent: 'spec-writer',
        model: 'opus',
        status: 'running',
        started_at: now,
      })
      .execute()
    const { id } = await getTestDb()
      .transaction()
      .execute((trx) =>
        openApproval(
          trx,
          { runId, taskId, phaseId, kind: 'question', question: 'How often?', options: [] },
          now,
          { recordEvent: true },
        ),
      )
    expect(await state(taskId)).toBe('needs_approval')
    await app.inject({
      method: 'POST',
      url: `/api/approvals/${id}/answer`,
      payload: { text: 'Three' },
    })
    expect(await state(taskId)).toBe('spec_draft')
  })

  it('is blocked when its runner is stopped, and drafts again on Resume', async () => {
    const { taskId, runId, token } = await drafting()
    const checkpoint = {
      stage: 'spec',
      attempt: 1,
      phase_id: null,
      session: null,
      head: null,
      plan_artifact_id: null,
      failing_report_id: null,
    }
    await send(token, [
      event(runId, 'checkpoint', checkpoint),
      event(runId, 'error', { blocks: true, cause: 'runner_stopped', stage: 'spec' }),
    ])
    expect(await state(taskId)).toBe('blocked')
    expect((await act(taskId, 'resume')).json().state).toBe('spec_draft')
  })
})

describe('claiming a re-run', () => {
  const PLAN = { confidence: 'high', steps: [{ files: ['src/a.ts'] }] }
  async function failedRun1() {
    const seeded = await seedQueuedRun(db(), { state: 'failed' })
    await db()
      .updateTable('runs')
      .set({ status: 'failed', queued_at: null })
      .where('id', '=', seeded.runId)
      .execute()
    await db()
      .insertInto('artifacts')
      .values({
        run_id: seeded.runId,
        phase_id: null,
        kind: 'plan',
        body_md: 'plan one',
        data: JSON.stringify(PLAN),
      })
      .execute()
    const ask = (kind: string, path: string) =>
      db()
        .insertInto('approval_requests')
        .values({
          run_id: seeded.runId,
          kind: kind as 'out_of_plan',
          question: 'May I?',
          options: '[]',
          context_md: 'code',
          status: 'answered',
          answer: JSON.stringify({ option_id: 'allow' }),
          files: JSON.stringify([path]),
          answered_at: now,
        })
        .execute()
    await ask('out_of_plan', 'src/extra.ts')
    await ask('migration', 'server/src/db/migrations/009_x.ts')
    return seeded
  }
  const rerun = (taskId: string, plan: 'keep' | 'again') =>
    app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/actions/rerun`,
      payload: { plan },
    })

  it('hands a kept run its copied plan, and none of the earlier allowances', async () => {
    const { taskId } = await failedRun1()
    expect((await rerun(taskId, 'keep')).statusCode).toBe(200)
    const work = (await claim()).json().work
    expect(work).toMatchObject({
      kind: 'start',
      run: { number: 2, previous_plans: [], kept_plan: { from_run: 1 } },
    })
    // The same run, resumed: its allowed files are its plan's alone.
    await db()
      .updateTable('runs')
      .set({
        status: 'queued',
        pending: 'resume',
        queued_at: at(1),
        checkpoint: JSON.stringify({
          stage: 'prepare',
          attempt: 1,
          phase_id: null,
          session: null,
          head: null,
          plan_artifact_id: work.run.kept_plan.artifact_id,
          failing_report_id: null,
        }),
      })
      .where('id', '=', work.run.id)
      .execute()
    const resumed = (await claim()).json().work
    expect(resumed).toMatchObject({
      kind: 'resume',
      allowed_files: ['src/a.ts'],
      approved_migrations: [],
      run: { kept_plan: { from_run: 1 }, previous_plans: [] },
    })
  })

  it('hands a re-planning run the previous plan, with whether it was accepted', async () => {
    const { taskId } = await failedRun1()
    expect((await rerun(taskId, 'again')).statusCode).toBe(200)
    const work = (await claim()).json().work
    expect(work.run).toMatchObject({
      number: 2,
      kept_plan: null,
      previous_plans: [{ run: 1, accepted: true, body_md: 'plan one' }],
    })
  })
})
