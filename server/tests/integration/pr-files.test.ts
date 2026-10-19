import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'
import type { Gh } from '../../src/modules/runs/pr-poller.js'

const calls: string[][] = []
let answer: Awaited<ReturnType<Gh>>
const gh: Gh = async (args) => {
  calls.push(args)
  return answer
}
const FILES = [{ path: 'src/retry.ts', additions: 3, deletions: 1 }]

let app: FastifyInstance
beforeAll(async () => {
  app = await buildTestApp({ gh })
})
beforeEach(async () => {
  await resetDb()
  calls.length = 0
  vi.restoreAllMocks()
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('GET /api/runs/:id/files', () => {
  it.each([
    {
      name: 'answers an empty list before there is a pull request, without asking GitHub',
      prNumber: null,
      gh: { code: 0, stdout: '', stderr: '' },
      body: { files: [] },
      asked: [],
      warnings: 0,
    },
    {
      name: 'lists the pull request’s files from GitHub',
      prNumber: 7,
      gh: { code: 0, stdout: JSON.stringify({ files: FILES }), stderr: '' },
      body: { files: FILES },
      asked: [['pr', 'view', '7', '--repo', 'owner/pay', '--json', 'files']],
      warnings: 0,
    },
    {
      name: 'answers null, with one warning, when GitHub does not list them',
      prNumber: 7,
      gh: { code: 1, stdout: '', stderr: 'Could not resolve to a Repository' },
      body: { files: null },
      asked: [['pr', 'view', '7', '--repo', 'owner/pay', '--json', 'files']],
      warnings: 1,
    },
  ])('$name', async ({ prNumber, gh: reply, body, asked, warnings }) => {
    answer = reply
    const warn = vi.spyOn(app.log, 'warn')
    const { runId } = await seedQueuedRun(getTestDb())
    await getTestDb()
      .updateTable('runs')
      .set({ pr_number: prNumber })
      .where('id', '=', runId)
      .execute()

    const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}/files` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(body)
    expect(calls).toEqual(asked)
    expect(warn).toHaveBeenCalledTimes(warnings)
    // An outside failure the board expects is not logged as though something broke.
    for (const [fields] of warn.mock.calls) expect(fields).not.toHaveProperty('err')
  })
})
