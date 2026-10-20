import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { ConflictError } from '../../shared/errors.js'
import { queueDeliveryRun } from '../specs/spec.service.js'
import { moveTask } from './task.moves.js'

export const ACTIONS = ['cancel', 'rerun'] as const
export type Action = (typeof ACTIONS)[number]

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
        .select(['id', 'status'])
        .where('task_id', '=', taskId)
        .where('status', 'in', ['queued', 'running'])
        .orderBy('created_at', 'desc')
        .executeTakeFirst()
      if (run === undefined) return
      // A queued run never started, so it ends here. A running one is stopped by the runner,
      // which learns of it in its next heartbeat and reports the run's end itself.
      await trx
        .updateTable('runs')
        .set(
          run.status === 'queued'
            ? { status: 'cancelled', ended_at: now, failure_reason: 'cancelled by the owner' }
            : { cancel_requested: true, failure_reason: 'cancelled by the owner' },
        )
        .where('id', '=', run.id)
        .execute()
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
