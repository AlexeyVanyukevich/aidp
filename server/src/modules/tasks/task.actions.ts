import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { ConflictError, ValidationError } from '../../shared/errors.js'
import { queueDeliveryRun, queueSpecRun } from '../specs/spec.service.js'
import { planToKeepFor } from './plan-history.queries.js'
import { moveFacts, moveTask } from './task.moves.js'

export const ACTIONS = ['cancel', 'rerun', 'resume', 'draft-spec'] as const
export type Action = (typeof ACTIONS)[number]

/** What a resumed agent reads after a block (spec §6). */
export const INTERRUPTED = 'You were interrupted. Continue from where you stopped.'

const blank = (text: string) => text.trim() === ''

/**
 * Cancel: the card leaves its run. A delivery run's card goes to Failed; a draft's goes back
 * where it came from (slice 3 spec, §2).
 */
async function cancel(trx: Transaction<Database>, taskId: string, now: Date): Promise<void> {
  const run = await trx
    .selectFrom('runs')
    .select(['id', 'kind', 'status', 'pending'])
    .where('task_id', '=', taskId)
    .where('status', 'in', ['queued', 'running', 'paused', 'blocked'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst()
  if (run?.kind === 'spec') await moveTask(trx, taskId, 'drop_draft', await moveFacts(trx, taskId))
  else await moveTask(trx, taskId, 'cancel')
  if (run === undefined) return
  const reason = 'cancelled by the owner'
  // A start still queued never began: it ends here. A running run is stopped by its runner,
  // which learns of it in its next heartbeat and reports the run's end itself. A run that
  // holds no process — paused, blocked, or answered but not yet resumed — leaves a worktree
  // behind, which the runner removes when it claims the cleanup.
  if (run.status === 'queued' && run.pending === null) {
    await trx
      .updateTable('runs')
      .set({ status: 'cancelled', ended_at: now, queued_at: null, failure_reason: reason })
      .where('id', '=', run.id)
      .execute()
    return
  }
  if (run.status === 'running') {
    await trx
      .updateTable('runs')
      .set({ cancel_requested: true, failure_reason: reason })
      .where('id', '=', run.id)
      .execute()
    return
  }
  await trx
    .updateTable('runs')
    .set({
      status: 'cancelled',
      ended_at: now,
      failure_reason: reason,
      pending: 'cleanup',
      queued_at: now,
      resume_message: null,
    })
    .where('id', '=', run.id)
    .execute()
  await trx
    .updateTable('approval_requests')
    .set({ status: 'withdrawn' })
    .where('run_id', '=', run.id)
    .where('status', 'in', ['open', 'expired'])
    .execute()
  await publish(trx, { topic: 'run.queued', runId: run.id })
}

export async function performAction(
  db: Kysely<Database>,
  taskId: string,
  action: Action,
  now: Date,
  /** Re-run only: keep the plan of an earlier run, or plan again (the default). */
  plan: 'keep' | 'again' = 'again',
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    if (action === 'cancel') {
      await cancel(trx, taskId, now)
      return
    }

    if (action === 'draft-spec') {
      // The move first: a card in the wrong state is a stale view (409), whatever it holds.
      await moveTask(trx, taskId, 'draft_spec')
      const task = await trx
        .selectFrom('tasks')
        .select('description_md')
        .where('id', '=', taskId)
        .executeTakeFirstOrThrow()
      if (blank(task.description_md))
        throw new ValidationError('The task has no description to draft from', {
          field: 'description_md',
        })
      await queueSpecRun(trx, taskId, { baseVersion: null, note: null }, now)
      return
    }

    if (action === 'resume') {
      const run = await trx
        .selectFrom('runs')
        .select(['id', 'block', 'checkpoint'])
        .where('task_id', '=', taskId)
        .where('status', '=', 'blocked')
        .orderBy('created_at', 'desc')
        .executeTakeFirst()
      await moveTask(trx, taskId, 'resume', await moveFacts(trx, taskId))
      // An expired question is answered, not resumed past: the agent would decide it itself.
      if (run === undefined || run.block?.cause === 'approval_expired')
        throw new ConflictError('This card is waiting on a question; answer it to go on', {
          reason: 'approval_expired',
        })
      if (run.checkpoint === null)
        throw new ConflictError('This run left no checkpoint to resume from', {
          reason: 'no_checkpoint',
        })
      await trx
        .updateTable('runs')
        .set({
          status: 'queued',
          pending: 'resume',
          queued_at: now,
          resume_message: INTERRUPTED,
          block: null,
        })
        .where('id', '=', run.id)
        .execute()
      await publish(trx, { topic: 'run.queued', runId: run.id })
      return
    }

    await moveTask(trx, taskId, 'rerun')
    const spec = await trx
      .selectFrom('specs')
      .select('version')
      .where('task_id', '=', taskId)
      .where('status', '=', 'approved')
      .orderBy('version', 'desc')
      .executeTakeFirst()
    if (spec === undefined) throw new ConflictError('This task has no approved spec to run')
    // Read before the new run exists: the plan to keep comes from the runs before it.
    const kept = plan === 'keep' ? await planToKeepFor(trx, taskId) : undefined
    if (plan === 'keep' && kept === undefined)
      throw new ConflictError('This task has no accepted plan to keep', { reason: 'no_plan' })
    const runId = await queueDeliveryRun(trx, taskId, spec.version, now)
    if (kept === undefined) return
    const source = await trx
      .selectFrom('artifacts')
      .select(['body_md', 'data'])
      .where('id', '=', kept.id)
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('artifacts')
      .values({
        run_id: runId,
        phase_id: null,
        kind: 'plan',
        body_md: source.body_md,
        data: JSON.stringify(source.data),
        copied_from_run: kept.runNumber,
      })
      .execute()
  })
}

/** Redraft: the latest version goes back to the spec-writer with the owner's note (§4). */
export async function redraft(
  db: Kysely<Database>,
  taskId: string,
  note: string,
  now: Date,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await moveTask(trx, taskId, 'redraft')
    if (blank(note)) throw new ValidationError('Say what to change', { field: 'note' })
    const latest = await trx
      .selectFrom('specs')
      .select('version')
      .where('task_id', '=', taskId)
      .orderBy('version', 'desc')
      .executeTakeFirst()
    if (latest === undefined) throw new ConflictError('This task has no spec to redraft')
    await queueSpecRun(trx, taskId, { baseVersion: latest.version, note: note.trim() }, now)
  })
}
