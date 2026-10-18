import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'
import { PrPoller, type Gh } from '../../src/modules/runs/pr-poller.js'

beforeEach(resetDb)
afterAll(closeTestDb)

const quiet = { warn: () => undefined }

async function inReview(prNumber: number) {
  const ids = await seedQueuedRun(getTestDb(), { state: 'review' })
  await getTestDb()
    .updateTable('runs')
    .set({
      status: 'succeeded',
      pr_number: prNumber,
      pr_url: `https://github.com/owner/pay/pull/${prNumber}`,
    })
    .where('id', '=', ids.runId)
    .execute()
  return ids
}

const state = async (taskId: string) =>
  (
    await getTestDb()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
  ).state

describe('PrPoller', () => {
  it.each([
    ['MERGED', 'done'],
    ['CLOSED', 'failed'],
    ['OPEN', 'review'],
  ])('moves a card whose PR is %s to %s', async (prState, expected) => {
    const { taskId } = await inReview(7)
    const calls: string[][] = []
    const gh: Gh = async (args) => {
      calls.push(args)
      return { code: 0, stdout: JSON.stringify({ state: prState }), stderr: '' }
    }
    await new PrPoller(getTestDb(), gh, quiet).tick()
    expect(calls).toEqual([['pr', 'view', '7', '--repo', 'owner/pay', '--json', 'state']])
    expect(await state(taskId)).toBe(expected)
  })

  it('leaves a card alone when gh fails, and says so', async () => {
    const { taskId } = await inReview(7)
    const warnings: string[] = []
    const gh: Gh = async () => ({ code: 1, stdout: '', stderr: 'HTTP 502' })
    await new PrPoller(getTestDb(), gh, { warn: (_obj, msg) => warnings.push(msg) }).tick()
    expect(await state(taskId)).toBe('review')
    expect(warnings).toEqual(['could not read a pull request'])
  })
})
