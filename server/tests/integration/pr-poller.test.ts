import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'
import { moveTask } from '../../src/modules/tasks/task.moves.js'
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

describe('PrPoller under a concurrent move', () => {
  it('waits for the card lock, warns of the conflict for that card alone, and goes on', async () => {
    const first = await inReview(7)
    const secondIds = await seedQueuedRun(getTestDb(), {
      projectId: first.projectId,
      state: 'review',
      number: 2,
    })
    await getTestDb()
      .updateTable('runs')
      .set({ status: 'succeeded', pr_number: 8, pr_url: 'https://github.com/owner/pay/pull/8' })
      .where('id', '=', secondIds.runId)
      .execute()
    // The card whose id sorts first is the one the poller meets first; it owns pull request 7.
    const sorted = [first, secondIds].sort((a, b) => (a.taskId < b.taskId ? -1 : 1))
    const [low, high] = sorted as [typeof first, typeof first]
    await getTestDb()
      .updateTable('runs')
      .set({ pr_number: 7 })
      .where('id', '=', low.runId)
      .execute()
    await getTestDb()
      .updateTable('runs')
      .set({ pr_number: 8 })
      .where('id', '=', high.runId)
      .execute()

    const warnings: { obj: Record<string, unknown>; msg: string }[] = []
    const gh: Gh = async () => ({
      code: 0,
      stdout: JSON.stringify({ state: 'MERGED' }),
      stderr: '',
    })
    const poller = new PrPoller(getTestDb(), gh, {
      warn: (obj, msg) => warnings.push({ obj: obj as Record<string, unknown>, msg }),
    })

    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const holder = getTestDb()
      .transaction()
      .execute(async (trx) => {
        await moveTask(trx, low.taskId, 'close_pr')
        locked()
        await held
      })
    await isLocked
    let settled = false
    const tick = poller.tick().then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(settled).toBe(false)
    release()
    await holder
    await tick

    expect(await state(low.taskId)).toBe('failed')
    expect(await state(high.taskId)).toBe('done')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.msg).toBe('the PR poller could not move a card')
    expect(warnings[0]?.obj).toMatchObject({
      taskId: low.taskId,
      key: low === first ? 'PAY-1' : 'PAY-2',
      move: 'merge',
    })
  })
})
