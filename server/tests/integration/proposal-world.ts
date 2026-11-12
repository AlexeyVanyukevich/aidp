import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBoardTools } from '../../src/modules/mcp/board-tools.js'
import type { PhaseName, RunKind } from '../../src/shared/vocabulary.js'
import { seedProject, seedRunningRun, seedTask } from './fixtures.js'
import { getTestDb } from './helpers.js'

export const GOOD_DESCRIPTION = [
  '**Where:** server/src/x.ts',
  '**Found:** 2026-11-12, while building',
  '**Problem:** it is wrong',
  '**Impact:** it costs',
].join('\n')

export type Call = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{ isError: boolean; text: string }>

export async function toolsFor(
  taskId: string,
  runId: string,
  clock: () => Date = () => new Date(),
  helpId?: string,
): Promise<Call> {
  const server = new McpServer({ name: 'board', version: '1.0.0' })
  registerBoardTools(server, {
    db: getTestDb(),
    runId,
    taskId,
    ...(helpId === undefined ? {} : { helpId }),
    clock,
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(b)
  return async (name, args = {}) => {
    try {
      const out = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean
        content: { text: string }[]
      }
      return { isError: out.isError === true, text: out.content[0]!.text }
    } catch (error) {
      return { isError: true, text: String(error) }
    }
  }
}

/** A task of AIDP with a run in the phase given; AIDP links to CHR and ZLR, not to ZLC. */
export async function world(
  options: { phase?: PhaseName; kind?: RunKind; runNumber?: number; taskNumber?: number } = {},
) {
  const db = getTestDb()
  const run = await seedRunningRun(db, { projectKey: 'AIDP', number: options.taskNumber ?? 95 })
  const chr = await seedProject(db, { key: 'CHR' })
  const zlr = await seedProject(db, { key: 'ZLR' })
  const zlc = await seedProject(db, { key: 'ZLC' })
  for (const linked of [chr, zlr])
    await db
      .insertInto('project_links')
      .values({ project_id: run.projectId, linked_project_id: linked.id, note: 'linked' })
      .execute()
  await db
    .updateTable('runs')
    .set({ number: options.runNumber ?? 2, kind: options.kind ?? 'delivery' })
    .where('id', '=', run.runId)
    .execute()
  if (options.phase !== undefined)
    await db
      .updateTable('phases')
      .set({ name: options.phase })
      .where('id', '=', run.phaseId)
      .execute()
  const call = await toolsFor(run.taskId, run.runId)
  return { ...run, chr, zlr, zlc, call }
}

export type World = Awaited<ReturnType<typeof world>>

export const propose = (w: World, overrides: Record<string, unknown> = {}) =>
  w.call('propose_task', {
    project: 'aidp',
    title: 'A finding',
    description_md: GOOD_DESCRIPTION,
    related: false,
    ...overrides,
  })

export async function addTask(projectId: string, number: number, title: string, state = 'done') {
  const task = await seedTask(getTestDb(), projectId, {
    number,
    title,
    state: state as 'done',
    position: number,
  })
  return task
}
