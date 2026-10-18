import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { ConflictError, NotFoundError } from '../../shared/errors.js'
import type { TaskState } from '../../shared/vocabulary.js'
import { nextState, type Move } from './transitions.js'

/**
 * The only writer of `tasks.state`. The row is locked first, so two movers — the owner's tab
 * and the runner — are serialised, and the loser gets a 409 rather than a lost update.
 */
export async function moveTask(
  db: Kysely<Database> | Transaction<Database>,
  taskId: string,
  move: Move,
): Promise<{ from: TaskState; to: TaskState }> {
  const task = await db
    .selectFrom('tasks')
    .select(['state', 'project_id'])
    .where('id', '=', taskId)
    .forUpdate()
    .executeTakeFirst()
  if (task === undefined) throw new NotFoundError('No such task')

  const to = nextState(task.state, move)
  if (to === undefined) {
    throw new ConflictError(`A task in ${task.state} cannot ${move.replaceAll('_', ' ')}`, {
      state: task.state,
      move,
    })
  }

  const { last } = await db
    .selectFrom('tasks')
    .select(sql<number>`coalesce(max(position), 0)`.as('last'))
    .where('project_id', '=', task.project_id)
    .where('state', '=', to)
    .executeTakeFirstOrThrow()

  await db
    .updateTable('tasks')
    .set({ state: to, position: last + 1, updated_at: new Date() })
    .where('id', '=', taskId)
    .execute()
  await publish(db, { topic: 'task.updated', taskId })
  return { from: task.state, to }
}
