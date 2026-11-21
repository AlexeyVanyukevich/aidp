import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { seedProject, seedQueuedRun, seedTask } from './fixtures.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'

type GhResult = { code: number; stdout: string; stderr: string }
const ghCalls: string[][] = []
let ghImpl: (args: string[]) => Promise<GhResult> = async () => ({
  code: 0,
  stdout: '',
  stderr: '',
})

let app: FastifyInstance
beforeAll(async () => {
  app = await buildTestApp({
    gh: async (args) => {
      ghCalls.push(args)
      return ghImpl(args)
    },
  })
})
beforeEach(async () => {
  ghCalls.length = 0
  ghImpl = async () => ({ code: 0, stdout: '', stderr: '' })
  await resetDb()
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})
const db = () => getTestDb()

const TEXT = '**Where:** a.ts\n**Found:** today\n**Problem:** p\n**Impact:** i'
const outsideFinding = (title: string, extra: Record<string, unknown> = {}) => ({
  kind: 'risk',
  text: TEXT,
  destination: 'outside',
  evidence: 'a.ts:1',
  title,
  ...extra,
})

/** A card in Spec review of the project AIDP, linked to CHR, with a succeeded review help. */
async function world(findings: unknown[], mode = 'review') {
  const own = await seedProject(db(), { key: 'AIDP' })
  const chr = await seedProject(db(), { key: 'CHR' })
  await db()
    .insertInto('project_links')
    .values({ project_id: own.id, linked_project_id: chr.id, note: 'n' })
    .execute()
  const { taskId, runId } = await seedQueuedRun(db(), {
    state: 'spec_review',
    projectId: own.id,
    number: 12,
  })
  await db().deleteFrom('runs').where('id', '=', runId).execute()
  await db()
    .updateTable('specs')
    .set({ status: 'draft', approved_at: null })
    .where('task_id', '=', taskId)
    .execute()
  const helpRun = await db()
    .insertInto('runs')
    .values({ task_id: taskId, kind: 'help', number: 1, status: 'succeeded' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const help = await db()
    .insertInto('helps')
    .values({
      run_id: helpRun.id,
      decision: 'spec_review',
      mode: mode as 'review',
      status: 'succeeded',
      subject: JSON.stringify({ spec_version: 1 }),
      result: JSON.stringify({
        mode,
        verdict: 'ready',
        blockers: 0,
        findings,
        unsure: 'u',
        next_step: 'approve',
        reasoning: 'r',
      }),
      created_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { own, chr, taskId, helpId: help.id }
}

const listed = async (taskId: string) =>
  (await app.inject({ url: `/api/tasks/${taskId}/helps` })).json()[0].result.findings
const file = (taskId: string, helpId: string, index: number) =>
  app.inject({ method: 'POST', url: `/api/tasks/${taskId}/helps/${helpId}/findings/${index}/file` })
const titled = (projectId: string, title: string) =>
  db()
    .selectFrom('tasks')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('title', '=', title)
    .execute()

describe('the outside findings of a review', () => {
  async function two() {
    const w = await world([
      outsideFinding('Same in own'),
      outsideFinding('Same in own', { project: 'CHR' }),
    ])
    await seedTask(db(), w.own.id, { title: 'same in own', number: 3, state: 'ready' })
    return w
  }

  it('looks each finding up in its own target project (AC7)', async () => {
    const w = await two()
    const findings = await listed(w.taskId)
    expect(findings[0].on_board).toMatchObject({ key: 'AIDP-3' })
    expect(findings[1].on_board).toBeNull()
  })

  it('files in the target project with a provenance line, and refuses a duplicate (AC7)', async () => {
    const w = await two()
    const duplicate = await file(w.taskId, w.helpId, 0)
    expect(duplicate.statusCode).toBe(409)
    expect(JSON.stringify(duplicate.json())).toContain('AIDP-3')
    expect(await titled(w.own.id, 'Same in own')).toHaveLength(0)

    const filed = await file(w.taskId, w.helpId, 1)
    expect(filed.statusCode).toBe(200)
    expect(filed.json()).toMatchObject({ key: 'CHR-1', state: 'backlog' })
    const tasks = await titled(w.chr.id, 'Same in own')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.state).toBe('backlog')
    expect(tasks[0]!.description_md).toMatch(
      new RegExp(`^${TEXT.replaceAll('*', '\\*')}\\n\\n.*Spec review of v1.*AIDP-12.*owner`),
    )
    expect((await listed(w.taskId))[1].on_board).toMatchObject({ key: 'CHR-1', state: 'backlog' })
    expect((await file(w.taskId, w.helpId, 1)).statusCode).toBe(409)
  })

  it('refuses a finding that is not outside and a help of another task (AC8)', async () => {
    const w = await world([
      { kind: 'missing', text: 'X', destination: 'blocker', evidence: 'R1' },
      outsideFinding('Elsewhere'),
    ])
    const other = await seedTask(db(), w.own.id, { number: 40 })
    const before = await db().selectFrom('tasks').select('id').execute()
    expect((await file(w.taskId, w.helpId, 0)).statusCode).toBe(409)
    expect((await file(w.taskId, w.helpId, 5)).statusCode).toBe(409)
    expect((await file(other.id, w.helpId, 1)).statusCode).toBe(409)
    await db().updateTable('helps').set({ status: 'failed' }).where('id', '=', w.helpId).execute()
    expect((await file(w.taskId, w.helpId, 1)).statusCode).toBe(409)
    expect(await db().selectFrom('tasks').select('id').execute()).toHaveLength(before.length)
  })
})

const COMMIT = 'abc1234def5678abc1234def5678abc1234def56'
const bug = {
  kind: 'bug',
  where: 'a.ts:1',
  text: 'Off by one',
  matters: 'm',
  destination: 'blocker',
  evidence: 'a.ts:1',
}

/** A card in Review, its run holding pull request #7, and a succeeded review help of it. */
async function inReview(
  step: string,
  findings: unknown[],
  options: { commit?: string | null; own?: Awaited<ReturnType<typeof seedProject>> } = {},
) {
  const own = options.own ?? (await seedProject(db(), { key: 'AIDP', github_repo: 'owner/aidp' }))
  const chr = await seedProject(db(), { key: `L${own.key}` })
  await db()
    .insertInto('project_links')
    .values({ project_id: own.id, linked_project_id: chr.id, note: 'n' })
    .execute()
  const { taskId, runId } = await seedQueuedRun(db(), {
    state: 'review',
    projectId: own.id,
    number: 12,
  })
  await db()
    .updateTable('runs')
    .set({
      status: 'succeeded',
      queued_at: null,
      pr_number: 7,
      pr_url: 'https://github.com/owner/aidp/pull/7',
    })
    .where('id', '=', runId)
    .execute()
  const addHelp = async (at: string, nextStep = step) => {
    const helpRun = await db()
      .insertInto('runs')
      .values({
        task_id: taskId,
        kind: 'help',
        number: 1 + Math.floor(Math.random() * 1e6),
        status: 'succeeded',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const help = await db()
      .insertInto('helps')
      .values({
        run_id: helpRun.id,
        decision: 'pull_request',
        mode: 'code_review',
        status: 'succeeded',
        subject: JSON.stringify({ pr_run_id: runId }),
        result: JSON.stringify({
          mode: 'code_review',
          verdict: findings.some((f) => (f as { destination: string }).destination === 'blocker')
            ? 'changes'
            : 'ready',
          blockers: findings.filter((f) => (f as { destination: string }).destination === 'blocker')
            .length,
          findings,
          next_step: nextStep,
          reasoning: 'r',
          unsure: 'u',
          commit: options.commit === undefined ? COMMIT : options.commit,
          skipped: [],
        }),
        created_at: new Date(at),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return help.id
  }
  const helpId = await addHelp('2026-11-20T10:00:00Z')
  return { own, chr, taskId, runId, helpId, addHelp }
}

const post = (url: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url, payload })
const merge = (w: { taskId: string; helpId: string }) =>
  post(`/api/tasks/${w.taskId}/helps/${w.helpId}/merge`)
const mergeAndFile = (w: { taskId: string; helpId: string }) =>
  post(`/api/tasks/${w.taskId}/helps/${w.helpId}/merge-and-file`)
const closeAndRerun = (w: { taskId: string; helpId: string }, note = 'The note') =>
  post(`/api/tasks/${w.taskId}/helps/${w.helpId}/close-and-rerun`, { note })
const stateOf = async (taskId: string) =>
  (
    await db()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
  ).state
const retired = async (helpId: string) =>
  (
    await db()
      .selectFrom('helps')
      .select('retired_at')
      .where('id', '=', helpId)
      .executeTakeFirstOrThrow()
  ).retired_at !== null
const outside = (title: string) => outsideFinding(title)

describe('Merge (AC10)', () => {
  it('runs gh with the exact arguments, moves the card to Done and retires the help', async () => {
    const w = await inReview('merge', [])
    const response = await merge(w)
    expect(response.statusCode).toBe(200)
    expect(ghCalls).toEqual([
      [
        'pr',
        'merge',
        '7',
        '--repo',
        'owner/aidp',
        '--rebase',
        '--delete-branch',
        '--match-head-commit',
        COMMIT,
      ],
    ])
    expect(await stateOf(w.taskId)).toBe('done')
    expect(await retired(w.helpId)).toBe(true)
  })

  it('counts a card the poller already moved to Done as a success', async () => {
    const w = await inReview('merge', [])
    ghImpl = async () => {
      await db().updateTable('tasks').set({ state: 'done' }).where('id', '=', w.taskId).execute()
      return { code: 0, stdout: '', stderr: '' }
    }
    expect((await merge(w)).statusCode).toBe(200)
    expect(await stateOf(w.taskId)).toBe('done')
  })

  it('moves nothing when gh fails, and carries gh stderr', async () => {
    const w = await inReview('merge', [])
    ghImpl = async () => ({ code: 1, stdout: '', stderr: 'head branch was modified' })
    const response = await merge(w)
    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(response.json())).toContain('head branch was modified')
    expect(await stateOf(w.taskId)).toBe('review')
    expect(await retired(w.helpId)).toBe(false)
  })

  it('refuses with 409 and runs no gh: a null commit, a card not in Review, an older help', async () => {
    const nullCommit = await inReview('merge', [], { commit: null })
    expect((await merge(nullCommit)).statusCode).toBe(409)

    const notReview = await inReview('merge', [], {
      own: await seedProject(db(), { key: 'PAY2', github_repo: 'o/p2' }),
    })
    await db()
      .updateTable('tasks')
      .set({ state: 'failed' })
      .where('id', '=', notReview.taskId)
      .execute()
    expect((await merge(notReview)).statusCode).toBe(409)

    const stale = await inReview('merge', [], {
      own: await seedProject(db(), { key: 'PAY3', github_repo: 'o/p3' }),
    })
    await stale.addHelp('2026-11-20T11:00:00Z')
    expect((await merge(stale)).statusCode).toBe(409)
    expect(ghCalls).toEqual([])
  })
})

describe('Merge, then file (AC11)', () => {
  it('files both tasks before gh merge is called', async () => {
    const w = await inReview('merge_and_file', [outside('First'), outside('Second')])
    let atMerge = 0
    ghImpl = async () => {
      atMerge = (
        await db()
          .selectFrom('tasks')
          .select('id')
          .where('title', 'in', ['First', 'Second'])
          .execute()
      ).length
      return { code: 0, stdout: '', stderr: '' }
    }
    expect((await mergeAndFile(w)).statusCode).toBe(200)
    expect(atMerge).toBe(2)
    expect(await stateOf(w.taskId)).toBe('done')
  })

  it('skips a finding already on the board', async () => {
    const w = await inReview('merge_and_file', [outside('First'), outside('Second')])
    await seedTask(db(), w.own.id, { title: 'first', number: 30 })
    expect((await mergeAndFile(w)).statusCode).toBe(200)
    expect(await titled(w.own.id, 'First')).toHaveLength(0)
    expect(await titled(w.own.id, 'Second')).toHaveLength(1)
  })

  it('creates nothing and runs no gh when a filing fails', async () => {
    const w = await inReview('merge_and_file', [outside('Twin'), outside('Twin')])
    expect((await mergeAndFile(w)).statusCode).toBe(409)
    expect(await titled(w.own.id, 'Twin')).toHaveLength(0)
    expect(ghCalls).toEqual([])
  })

  it('keeps the filed tasks and the card in Review when gh fails', async () => {
    const w = await inReview('merge_and_file', [outside('First'), outside('Second')])
    ghImpl = async () => ({ code: 1, stdout: '', stderr: 'nope' })
    expect((await mergeAndFile(w)).statusCode).toBeGreaterThanOrEqual(400)
    expect(await titled(w.own.id, 'First')).toHaveLength(1)
    expect(await titled(w.own.id, 'Second')).toHaveLength(1)
    expect(await stateOf(w.taskId)).toBe('review')
  })

  it('refuses a result whose step is not merge_and_file', async () => {
    const w = await inReview('merge', [])
    expect((await mergeAndFile(w)).statusCode).toBe(409)
    expect(ghCalls).toEqual([])
  })
})

describe('Close the pull request, then Re-run (AC12, AC13)', () => {
  const findings = [bug, outside('Elsewhere')]

  it('closes first, then fails the old run and queues a Re-run with the note sent', async () => {
    const w = await inReview('rerun_again', findings)
    let stateAtClose = ''
    ghImpl = async () => {
      stateAtClose = await stateOf(w.taskId)
      return { code: 0, stdout: '', stderr: '' }
    }
    const response = await closeAndRerun(w, 'Fix the off by one')
    expect(response.statusCode).toBe(200)
    expect(ghCalls).toEqual([['pr', 'close', '7', '--repo', 'owner/aidp']])
    expect(stateAtClose).toBe('review')
    expect(await stateOf(w.taskId)).toBe('ready')
    const runs = await db()
      .selectFrom('runs')
      .select(['status', 'note', 'failure_reason'])
      .where('task_id', '=', w.taskId)
      .where('kind', '=', 'delivery')
      .orderBy('created_at')
      .execute()
    expect(runs).toHaveLength(2)
    expect(runs[0]!.failure_reason).toBe('pull request closed without merging')
    expect(runs[1]).toMatchObject({ status: 'queued', note: 'Fix the off by one' })
  })

  it('still queues the Re-run when the poller moved the card to Failed meanwhile', async () => {
    const w = await inReview('rerun_again', findings)
    ghImpl = async () => {
      await db().updateTable('tasks').set({ state: 'failed' }).where('id', '=', w.taskId).execute()
      await db()
        .updateTable('runs')
        .set({ status: 'failed', failure_reason: 'pull request closed without merging' })
        .where('id', '=', w.runId)
        .execute()
      return { code: 0, stdout: '', stderr: '' }
    }
    expect((await closeAndRerun(w)).statusCode).toBe(200)
    expect(await stateOf(w.taskId)).toBe('ready')
  })

  it('leaves the card in Review when gh fails', async () => {
    const w = await inReview('rerun_again', findings)
    ghImpl = async () => ({ code: 1, stdout: '', stderr: 'cannot close' })
    const response = await closeAndRerun(w)
    expect(JSON.stringify(response.json())).toContain('cannot close')
    expect(await stateOf(w.taskId)).toBe('review')
  })

  it('refuses with 409 and runs no gh: no plan to keep, a Failed card, an older help', async () => {
    const keep = await inReview('rerun_keep', findings)
    expect((await closeAndRerun(keep)).statusCode).toBe(409)

    const failed = await inReview('rerun_again', findings, {
      own: await seedProject(db(), { key: 'PAY2', github_repo: 'o/p2' }),
    })
    await db()
      .updateTable('tasks')
      .set({ state: 'failed' })
      .where('id', '=', failed.taskId)
      .execute()
    expect((await closeAndRerun(failed)).statusCode).toBe(409)

    const stale = await inReview('rerun_again', findings, {
      own: await seedProject(db(), { key: 'PAY3', github_repo: 'o/p3' }),
    })
    await stale.addHelp('2026-11-20T11:00:00Z')
    expect((await closeAndRerun(stale)).statusCode).toBe(409)
    expect(ghCalls).toEqual([])
  })
})
