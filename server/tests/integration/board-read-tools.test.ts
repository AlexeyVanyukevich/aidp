import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { inject } from 'vitest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerBoardTools } from '../../src/modules/mcp/board-tools.js'
import { Bus, type BoardMessage } from '../../src/shared/bus.js'
import type { TaskState } from '../../src/shared/vocabulary.js'
import { seedProject, seedQueuedRun, seedTask } from './fixtures.js'
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

async function tools(taskId: string, runId: string, helpId?: string) {
  const server = new McpServer({ name: 'board', version: '1.0.0' })
  registerBoardTools(server, {
    db: db(),
    runId,
    taskId,
    ...(helpId === undefined ? {} : { helpId }),
    clock: () => new Date(),
  })
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

/** A run token on a task of AIDP, and projects ZLR and CHR beside it. */
async function board() {
  const aidp = await seedQueuedRun(db(), { projectKey: 'AIDP' })
  await db()
    .updateTable('projects')
    .set({ name: 'Board' })
    .where('id', '=', aidp.projectId)
    .execute()
  const zlr = await seedProject(db(), { key: 'ZLR' })
  await db()
    .updateTable('projects')
    .set({ name: 'Zellige React' })
    .where('id', '=', zlr.id)
    .execute()
  const chr = await seedProject(db(), { key: 'CHR' })
  await db().updateTable('projects').set({ name: 'Charter' }).where('id', '=', chr.id).execute()
  const call = await tools(aidp.taskId, aidp.runId)
  return { aidp, zlr, chr, call }
}

async function addTask(
  projectId: string,
  number: number,
  title: string,
  state: TaskState = 'backlog',
  description = '',
) {
  const task = await seedTask(db(), projectId, { number, title, state, position: number })
  await db()
    .updateTable('tasks')
    .set({ description_md: description })
    .where('id', '=', task.id)
    .execute()
  return task
}

describe('list_projects', () => {
  it('lists every project ordered by key (AC1)', async () => {
    const { call } = await board()
    const out = await call('list_projects')
    expect(out.isError).toBe(false)
    expect(JSON.parse(out.text)).toEqual([
      { key: 'AIDP', name: 'Board' },
      { key: 'CHR', name: 'Charter' },
      { key: 'ZLR', name: 'Zellige React' },
    ])
  })
})

describe('list_tasks', () => {
  it('lists a project of another run in every state, ordered by number (AC2)', async () => {
    const { zlr, call } = await board()
    await addTask(zlr.id, 3, 'Third', 'failed')
    await addTask(zlr.id, 1, 'First', 'backlog')
    await addTask(zlr.id, 2, 'Second', 'done')
    const out = await call('list_tasks', { project: 'ZLR' })
    expect(JSON.parse(out.text)).toEqual([
      { key: 'ZLR-1', title: 'First', state: 'backlog' },
      { key: 'ZLR-2', title: 'Second', state: 'done' },
      { key: 'ZLR-3', title: 'Third', state: 'failed' },
    ])
  })

  it('gives an empty list for a project with no tasks (AC3)', async () => {
    const { call } = await board()
    const out = await call('list_tasks', { project: 'CHR' })
    expect(out.isError).toBe(false)
    expect(JSON.parse(out.text)).toEqual([])
  })

  interface FilterRow {
    name: string
    filter: string | undefined
    expected: string[]
  }
  const TASKS = [
    { title: 'Radio group broken', description: '', n: 1 },
    { title: 'Checkbox', description: 'the radio is wrong', n: 2 },
    { title: 'Tabs', description: '100% sure', n: 3 },
    { title: 'Under_score', description: '', n: 4 },
    { title: 'Back\\slash', description: '', n: 5 },
    { title: 'Plain', description: 'nothing', n: 6 },
  ]
  const ALL = ['ZLR-1', 'ZLR-2', 'ZLR-3', 'ZLR-4', 'ZLR-5', 'ZLR-6']
  const rows: FilterRow[] = [
    { name: 'title only', filter: 'broken', expected: ['ZLR-1'] },
    { name: 'description only', filter: 'is wrong', expected: ['ZLR-2'] },
    { name: 'case difference', filter: 'RADIO', expected: ['ZLR-1', 'ZLR-2'] },
    { name: 'no match', filter: 'zzz', expected: [] },
    { name: 'empty filter', filter: '', expected: ALL },
    { name: 'absent filter', filter: undefined, expected: ALL },
    { name: 'padded filter', filter: '  radio ', expected: ['ZLR-1', 'ZLR-2'] },
    { name: 'only spaces', filter: '   ', expected: ALL },
    { name: 'percent is literal', filter: '%', expected: ['ZLR-3'] },
    { name: 'underscore is literal', filter: '_', expected: ['ZLR-4'] },
    { name: 'backslash is literal', filter: '\\', expected: ['ZLR-5'] },
  ]
  it.each(rows)('filters: $name (AC4)', async (row) => {
    const { zlr, call } = await board()
    for (const t of TASKS) await addTask(zlr.id, t.n, t.title, 'backlog', t.description)
    const out = await call('list_tasks', {
      project: 'ZLR',
      ...(row.filter === undefined ? {} : { filter: row.filter }),
    })
    expect(out.isError).toBe(false)
    expect((JSON.parse(out.text) as { key: string }[]).map((t) => t.key)).toEqual(row.expected)
  })
})

describe('read_task', () => {
  const specRow = (task_id: string, version: number, status: 'draft' | 'approved' | 'superseded') =>
    db()
      .insertInto('specs')
      .values({ task_id, version, body_md: `body ${version}`, status })
      .execute()

  it('returns the highest spec version with its stored status (AC5)', async () => {
    const { zlr, call } = await board()
    const task = await addTask(zlr.id, 12, 'Twelve', 'review', 'desc')
    await specRow(task.id, 1, 'superseded')
    await specRow(task.id, 2, 'approved')
    const out = await call('read_task', { key: 'ZLR-12' })
    expect(JSON.parse(out.text)).toEqual({
      key: 'ZLR-12',
      title: 'Twelve',
      state: 'review',
      description_md: 'desc',
      spec: { version: 2, status: 'approved', body_md: 'body 2' },
    })
  })

  it('reports a draft status, and null when there is no spec (AC6)', async () => {
    const { zlr, call } = await board()
    const drafted = await addTask(zlr.id, 1, 'Drafted')
    await addTask(zlr.id, 2, 'Bare')
    await specRow(drafted.id, 1, 'draft')
    expect(JSON.parse((await call('read_task', { key: 'ZLR-1' })).text).spec.status).toBe('draft')
    expect(JSON.parse((await call('read_task', { key: 'ZLR-2' })).text).spec).toBeNull()
  })
})

describe('case folding', () => {
  interface Row {
    tool: 'list_tasks' | 'read_task'
    args: Record<string, unknown>
    same: Record<string, unknown>
    keys: RegExp
  }
  const rows: Row[] = [
    { tool: 'list_tasks', args: { project: 'zlr' }, same: { project: 'ZLR' }, keys: /ZLR-/ },
    { tool: 'list_tasks', args: { project: 'Zlr' }, same: { project: 'ZLR' }, keys: /ZLR-/ },
    { tool: 'read_task', args: { key: 'zlr-12' }, same: { key: 'ZLR-12' }, keys: /ZLR-12/ },
  ]
  it.each(rows)('$tool $args finds the upper-case key (AC7)', async (row) => {
    const { zlr, call } = await board()
    await addTask(zlr.id, 12, 'Twelve')
    const folded = await call(row.tool, row.args)
    const exact = await call(row.tool, row.same)
    expect(folded.isError).toBe(false)
    expect(folded.text).toBe(exact.text)
    expect(folded.text).toMatch(row.keys)
    expect(folded.text).not.toMatch(/zlr-/)
  })

  it('leaves the HTTP route matching keys exactly (AC8)', async () => {
    await board()
    const response = await app.inject({ method: 'GET', url: '/api/projects/zlr/tasks' })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('not_found')
  })
})

describe('errors', () => {
  interface Row {
    tool: 'list_tasks' | 'read_task'
    args: Record<string, unknown>
    names: string
    listsProjects: boolean
  }
  const rows: Row[] = [
    { tool: 'list_tasks', args: { project: 'nope' }, names: 'NOPE', listsProjects: true },
    { tool: 'read_task', args: { key: 'ZLR12' }, names: 'ZLR12', listsProjects: false },
    { tool: 'read_task', args: { key: 'zlr-x' }, names: 'ZLR-X', listsProjects: false },
    { tool: 'read_task', args: { key: 'ZLR-0' }, names: 'ZLR-0', listsProjects: false },
    { tool: 'read_task', args: { key: 'A-3' }, names: 'A-3', listsProjects: false },
    { tool: 'read_task', args: { key: '1AB-3' }, names: '1AB-3', listsProjects: false },
    { tool: 'read_task', args: { key: 'ZLR-012' }, names: 'ZLR-012', listsProjects: false },
    { tool: 'read_task', args: { key: 'nope-1' }, names: 'NOPE-1', listsProjects: true },
    { tool: 'read_task', args: { key: 'ZLR-99999' }, names: 'ZLR-99999', listsProjects: false },
  ]
  it.each(rows)('$tool $args is an error (AC9)', async (row) => {
    const { call } = await board()
    const out = await call(row.tool, row.args)
    expect(out.isError).toBe(true)
    expect(out.text).toContain(row.names)
    if (row.listsProjects) for (const key of ['AIDP', 'CHR', 'ZLR']) expect(out.text).toContain(key)
  })
})

describe('reading only', () => {
  it('changes no table and publishes nothing (AC10)', async () => {
    const { zlr, call } = await board()
    const task = await addTask(zlr.id, 1, 'One')
    await db()
      .insertInto('specs')
      .values({ task_id: task.id, version: 1, body_md: 'b', status: 'draft' })
      .execute()
    const snapshot = async () => {
      const tables = await sql<{
        table_name: string
      }>`select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`.execute(db())
      const out: Record<string, string> = {}
      for (const { table_name } of tables.rows) {
        const r = await sql<{ n: string; h: string | null }>`select count(*)::text as n,
          md5(coalesce(string_agg(t::text, '' order by t::text), '')) as h
          from ${sql.table(table_name)} t`.execute(db())
        out[table_name] = `${r.rows[0]!.n}:${r.rows[0]!.h}`
      }
      return out
    }
    const bus = new Bus(inject('databaseUrl'))
    await bus.start()
    const seen: BoardMessage[] = []
    bus.subscribe((m) => seen.push(m))
    const before = await snapshot()
    await call('list_projects')
    await call('list_tasks', { project: 'ZLR', filter: 'one' })
    await call('read_task', { key: 'ZLR-1' })
    await call('read_task', { key: 'bad' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await bus.stop()
    expect(await snapshot()).toEqual(before)
    expect(seen).toEqual([])
  })
})

describe('helper tokens', () => {
  it.each(['question', 'decision'])('answers for a %s help (AC11)', async (_kind) => {
    const { aidp, zlr } = await board()
    await addTask(zlr.id, 1, 'One')
    const call = await tools(aidp.taskId, aidp.runId, crypto.randomUUID())
    for (const [name, args] of [
      ['list_projects', {}],
      ['list_tasks', { project: 'ZLR' }],
      ['read_task', { key: 'ZLR-1' }],
    ] as const) {
      const out = await call(name, args)
      expect(out.isError, out.text).toBe(false)
    }
  })
})
