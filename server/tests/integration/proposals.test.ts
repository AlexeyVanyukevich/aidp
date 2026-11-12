import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PAUSED_REPLY } from '../../src/modules/mcp/board-tools.js'
import { seedRunningRun } from './fixtures.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import {
  GOOD_DESCRIPTION,
  addTask,
  propose,
  toolsFor,
  world,
  type World,
} from './proposal-world.js'

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
const proposals = (runId: string) =>
  db().selectFrom('proposals').selectAll().where('run_id', '=', runId).orderBy('number').execute()
const events = (runId: string) =>
  db()
    .selectFrom('events')
    .selectAll()
    .where('run_id', '=', runId)
    .where('type', '=', 'message')
    .execute()

describe('propose_task', () => {
  it('saves an unrelated proposal and leaves the run running (AC1)', async () => {
    const w = await world()
    const tasksBefore = await db().selectFrom('tasks').select('id').execute()
    const out = await propose(w, { bearing_md: 'came up while building' })
    expect(out.isError).toBe(false)
    expect(out.text).toContain('owner settles it on the card')
    const saved = await proposals(w.runId)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ number: 1, outcome: null, related: false, approval_id: null })
    expect(await db().selectFrom('tasks').select('id').execute()).toHaveLength(tasksBefore.length)
    const phase = await db()
      .selectFrom('phases')
      .select('status')
      .where('id', '=', w.phaseId)
      .executeTakeFirstOrThrow()
    expect(phase.status).toBe('running')
    const [event] = await events(w.runId)
    expect(event).toMatchObject({ agent: 'builder' })
    expect(event?.payload).toMatchObject({ declared: true, summary: 'Proposed: A finding' })
  })

  const projects: { project: string; ok: boolean }[] = [
    { project: 'AIDP', ok: true },
    { project: 'chr', ok: true },
    { project: 'ZLR', ok: true },
    { project: 'ZLC', ok: false },
    { project: 'NOPE', ok: false },
  ]
  it.each(projects)('project $project (AC2)', async ({ project, ok }) => {
    const w = await world()
    const out = await propose(w, { project })
    expect(out.isError).toBe(!ok)
    expect(await proposals(w.runId)).toHaveLength(ok ? 1 : 0)
    if (!ok) {
      expect(out.text).toContain(project.toUpperCase())
      expect(out.text).toContain('AIDP, CHR, ZLR')
    }
  })

  it('reads the links when the call is made (AC3)', async () => {
    const w = await world()
    await db()
      .insertInto('project_links')
      .values({ project_id: w.projectId, linked_project_id: w.zlc.id, note: 'new' })
      .execute()
    expect((await propose(w, { project: 'ZLC' })).isError).toBe(false)
  })

  const titles: { name: string; title: string; stored?: string; names?: string }[] = [
    { name: 'empty', title: '', names: 'title' },
    { name: 'spaces', title: '   ', names: 'title' },
    { name: '201 characters', title: 'a'.repeat(201), names: 'title' },
    { name: '200 characters', title: 'a'.repeat(200), stored: 'a'.repeat(200) },
    { name: 'padded 200', title: `  ${'a'.repeat(200)}`, stored: 'a'.repeat(200) },
    { name: 'padded', title: '  A title  ', stored: 'A title' },
  ]
  it.each(titles)('title $name (AC4)', async ({ title, stored, names }) => {
    const w = await world()
    const out = await propose(w, { title })
    if (stored === undefined) {
      expect(out.isError).toBe(true)
      expect(out.text).toContain(names)
    } else {
      expect(out.isError).toBe(false)
      expect((await proposals(w.runId))[0]?.title).toBe(stored)
    }
  })

  it('refuses a description without a label, giving the form (AC5)', async () => {
    const w = await world()
    const out = await propose(w, { description_md: '**Where:** x\n**Found:** y\n**Problem:** z' })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('Impact')
    expect(out.text).toContain('**Where:** …')
    expect(await proposals(w.runId)).toHaveLength(0)
  })

  it('refuses a description past the limit with the proposed-by line (AC7)', async () => {
    const w = await world()
    const out = await propose(w, {
      description_md: `${GOOD_DESCRIPTION}\n${'x'.repeat(100_000 - GOOD_DESCRIPTION.length - 1)}`,
    })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('description_md')
    expect(await proposals(w.runId)).toHaveLength(0)
  })

  describe('duplicates (AC6)', () => {
    const query = '  radio CANNOT be unticked '
    interface Row {
      name: string
      seed: (w: World) => Promise<void>
      refused: string[] | null
    }
    const otherProposal = async (
      w: World,
      kind: 'delivery' | 'spec',
      number: number,
      outcome: 'dismiss' | null,
      own: boolean,
    ) => {
      let runId = w.runId
      let taskId = w.taskId
      let phaseId = w.phaseId
      if (!own) {
        const other = await seedRunningRun(db(), { projectId: w.projectId, number: 60 })
        await db().updateTable('runs').set({ kind, number }).where('id', '=', other.runId).execute()
        runId = other.runId
        taskId = other.taskId
        phaseId = other.phaseId
      }
      await db()
        .insertInto('proposals')
        .values({
          run_id: runId,
          phase_id: phaseId,
          task_id: taskId,
          project_id: w.projectId,
          number: own ? 1 : 1,
          title: 'Radio cannot be unticked',
          description_md: GOOD_DESCRIPTION,
          related: false,
          outcome,
          settled_at: outcome === null ? null : new Date(),
        })
        .execute()
    }
    const rows: Row[] = [
      {
        name: 'a done task',
        seed: async (w) => void (await addTask(w.projectId, 7, 'Radio cannot be unticked')),
        refused: ['AIDP-7', 'done'],
      },
      {
        name: 'the same title elsewhere',
        seed: async (w) => void (await addTask(w.zlr.id, 1, 'Radio cannot be unticked')),
        refused: null,
      },
      {
        name: 'a dismissed proposal of this run',
        seed: (w) => otherProposal(w, 'delivery', 2, 'dismiss', true),
        refused: ['Run 2', 'dismissed'],
      },
      {
        name: 'an open proposal of another run',
        seed: (w) => otherProposal(w, 'delivery', 1, null, false),
        refused: ['AIDP-60, Run 1', 'open'],
      },
      {
        name: 'an open proposal of a draft',
        seed: (w) => otherProposal(w, 'spec', 1, null, false),
        refused: ['AIDP-60, Draft 1'],
      },
      {
        name: 'a dismissed proposal of another run',
        seed: (w) => otherProposal(w, 'delivery', 1, 'dismiss', false),
        refused: null,
      },
    ]
    it.each(rows)('$name', async ({ seed, refused }) => {
      const w = await world()
      await seed(w)
      const out = await propose(w, { title: query })
      expect(out.isError).toBe(refused !== null)
      for (const part of refused ?? []) expect(out.text).toContain(part)
    })
  })

  describe('refusals (AC8)', () => {
    interface Row {
      name: string
      options?: Parameters<typeof world>[0]
      args?: Record<string, unknown>
      prepare?: (w: World) => Promise<void>
      refused: string | null
      bearing?: null
    }
    const rows: Row[] = [
      {
        name: 'no running phase',
        prepare: async (w) =>
          void (await db()
            .updateTable('phases')
            .set({ status: 'succeeded' })
            .where('id', '=', w.phaseId)
            .execute()),
        refused: 'phase',
      },
      { name: 'a title run', options: { kind: 'title' }, refused: 'title run' },
      { name: 'a rephrase run', options: { kind: 'rephrase' }, refused: 'rephrase run' },
      { name: 'a help phase', options: { phase: 'help' }, refused: 'phase' },
      {
        name: 'build related',
        args: { related: true, bearing_md: 'b' },
        refused: 'request_approval',
      },
      {
        name: 'verify related',
        options: { phase: 'verify' },
        args: { related: true, bearing_md: 'b' },
        refused: 'related',
      },
      {
        name: 'spec related without bearing',
        options: { phase: 'spec', kind: 'spec' },
        args: { related: true },
        refused: 'bearing_md',
      },
      {
        name: 'plan related blank bearing',
        options: { phase: 'plan' },
        args: { related: true, bearing_md: '   ' },
        refused: 'bearing_md',
      },
      { name: 'a long bearing', args: { bearing_md: 'a'.repeat(2001) }, refused: 'bearing_md' },
      {
        name: 'plan unrelated workaround',
        options: { phase: 'plan' },
        args: { workaround_md: 'w' },
        refused: 'workaround_md',
      },
      { name: 'unrelated, no bearing', refused: null },
      { name: 'unrelated, blank bearing', args: { bearing_md: '   ' }, refused: null },
    ]
    it.each(rows)('$name', async ({ options, args, prepare, refused }) => {
      const w = await world(options)
      await prepare?.(w)
      const out = await propose(w, args)
      expect(out.isError).toBe(refused !== null)
      if (refused !== null) {
        expect(out.text).toContain(refused)
        expect(await proposals(w.runId)).toHaveLength(0)
        expect(await events(w.runId)).toHaveLength(0)
      } else {
        expect((await proposals(w.runId))[0]?.bearing_md).toBeNull()
      }
    })
  })

  it('is not a tool of a helper (AC9)', async () => {
    const w = await world()
    const helper = await toolsFor(w.taskId, w.runId, undefined, crypto.randomUUID())
    for (const name of ['propose_task', 'list_proposals']) {
      const out = await helper(name, { project: 'AIDP' })
      expect(out.isError).toBe(true)
    }
    expect(await proposals(w.runId)).toHaveLength(0)
  })

  it('stops at the cap of ten, dismissed ones counted (AC10)', async () => {
    const w = await world()
    for (let i = 1; i <= 10; i++) {
      await db()
        .insertInto('proposals')
        .values({
          run_id: w.runId,
          phase_id: w.phaseId,
          task_id: w.taskId,
          project_id: w.projectId,
          number: i,
          title: `T${i}`,
          description_md: 'd',
          related: false,
          ...(i <= 3 ? { outcome: 'dismiss' as const, settled_at: new Date() } : {}),
        })
        .execute()
    }
    const out = await propose(w, { title: 'Eleventh' })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('cap of 10')
    expect(out.text).toContain('report or summary')
    expect(await proposals(w.runId)).toHaveLength(10)
  })

  it('lets one of two concurrent calls through at nine (AC11)', async () => {
    const w = await world()
    for (let i = 1; i <= 9; i++)
      await db()
        .insertInto('proposals')
        .values({
          run_id: w.runId,
          phase_id: w.phaseId,
          task_id: w.taskId,
          project_id: w.projectId,
          number: i,
          title: `T${i}`,
          description_md: 'd',
          related: false,
        })
        .execute()
    const outs = await Promise.all([propose(w, { title: 'One' }), propose(w, { title: 'Two' })])
    expect(outs.filter((o) => !o.isError)).toHaveLength(1)
    expect(await proposals(w.runId)).toHaveLength(10)
  })

  it('saves one of two concurrent calls with one title (AC12)', async () => {
    const w = await world()
    const outs = await Promise.all([propose(w, { title: 'Same' }), propose(w, { title: 'same' })])
    expect(outs.filter((o) => !o.isError)).toHaveLength(1)
    expect(await proposals(w.runId)).toHaveLength(1)
  })

  it('pauses the run for a related proposal and refuses a second (AC14)', async () => {
    const w = await world({ phase: 'spec', kind: 'spec' })
    await db()
      .updateTable('tasks')
      .set({ state: 'spec_draft' })
      .where('id', '=', w.taskId)
      .execute()
    const out = await propose(w, { related: true, bearing_md: 'it blocks', workaround_md: 'do x' })
    expect(out).toEqual({ isError: false, text: PAUSED_REPLY })
    const approval = await db()
      .selectFrom('approval_requests')
      .selectAll()
      .where('run_id', '=', w.runId)
      .executeTakeFirstOrThrow()
    expect(approval).toMatchObject({ kind: 'proposal', question: 'A finding', status: 'open' })
    const task = await db()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', w.taskId)
      .executeTakeFirstOrThrow()
    expect(task.state).toBe('needs_approval')
    const run = await db()
      .selectFrom('runs')
      .select('status')
      .where('id', '=', w.runId)
      .executeTakeFirstOrThrow()
    expect(run.status).toBe('paused')
    for (const second of [
      await propose(w, { title: 'Other', related: true, bearing_md: 'b' }),
      await w.call('request_approval', { question: 'Q?' }),
    ]) {
      expect(second.isError).toBe(true)
      expect(second.text).toContain('already waiting')
    }
    expect(await proposals(w.runId)).toHaveLength(1)
  })
})

describe('list_proposals', () => {
  it('equals the HTTP body, newest run first (AC24, AC25)', async () => {
    const w = await world()
    expect(JSON.parse((await w.call('list_proposals')).text)).toEqual([])
    await propose(w, { title: 'First' })
    await propose(w, { title: 'Second' })
    const http = await app.inject({ method: 'GET', url: `/api/tasks/${w.taskId}/proposals` })
    expect(http.statusCode).toBe(200)
    const listed = JSON.parse((await w.call('list_proposals')).text) as {
      title: string
      run: object
      offered: string[]
    }[]
    expect(listed).toEqual(http.json())
    expect(listed.map((p) => p.title)).toEqual(['First', 'Second'])
    expect(listed[0]).toMatchObject({
      run: { kind: 'delivery', number: 2 },
      offered: ['file', 'dismiss'],
    })
    const missing = await app.inject({
      method: 'GET',
      url: `/api/tasks/${crypto.randomUUID()}/proposals`,
    })
    expect(missing.statusCode).toBe(404)
  })
})
