import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { ConflictError } from '../../shared/errors.js'
import { queueDeliveryRun } from '../specs/spec.service.js'
import { moveTask } from './task.moves.js'

export const ACTIONS = ['cancel', 'rerun', 'resume'] as const
export type Action = (typeof ACTIONS)[number]

/** What a resumed agent reads after a block (spec §6). */
export const INTERRUPTED = 'You were interrupted. Continue from where you stopped.'

export async function performAction(
  db: Kysely<Database>,
  taskId: string,
  action: Action,
  now: Date,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    if (action === 'cancel') {
      await moveTask(trx, taskId, 'cancel')
      const run = await trx
        .selectFrom('runs')
        .select(['id', 'status', 'pending'])
        .where('task_id', '=', taskId)
        .where('status', 'in', ['queued', 'running', 'paused', 'blocked'])
        .orderBy('created_at', 'desc')
        .executeTakeFirst()
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
      return
    }

    if (action === 'resume') {
      await moveTask(trx, taskId, 'resume')
      const run = await trx
        .selectFrom('runs')
        .select(['id', 'block', 'checkpoint'])
        .where('task_id', '=', taskId)
        .where('status', '=', 'blocked')
        .orderBy('created_at', 'desc')
        .executeTakeFirst()
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
    await queueDeliveryRun(trx, taskId, spec.version, now)
  })
}
