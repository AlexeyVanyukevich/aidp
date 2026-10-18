import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'
import type { Gh } from '../../src/modules/runs/pr-poller.js'

const calls: string[][] = []
const gh: Gh = async (args) => {
  calls.push(args)
  return {
    code: 0,
    stdout: JSON.stringify({ files: [{ path: 'src/retry.ts', additions: 3, deletions: 1 }] }),
    stderr: '',
  }
}

let app: FastifyInstance
beforeAll(async () => {
  app = await buildTestApp({ gh })
})
beforeEach(async () => {
  await resetDb()
  calls.length = 0
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('GET /api/runs/:id/files', () => {
  it('lists the pull request’s files from GitHub', async () => {
    const { runId } = await seedQueuedRun(getTestDb())
    await getTestDb().updateTable('runs').set({ pr_number: 7 }).where('id', '=', runId).execute()
    const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}/files` })
    expect(response.json()).toEqual([{ path: 'src/retry.ts', additions: 3, deletions: 1 }])
    expect(calls).toEqual([['pr', 'view', '7', '--repo', 'owner/pay', '--json', 'files']])
  })

  it('answers an empty list before there is a pull request, without asking GitHub', async () => {
    const { runId } = await seedQueuedRun(getTestDb())
    expect((await app.inject({ method: 'GET', url: `/api/runs/${runId}/files` })).json()).toEqual(
      [],
    )
    expect(calls).toEqual([])
  })
})
