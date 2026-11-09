import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { ConflictError, NotFoundError } from '../../shared/errors.js'
import type { TaskState } from '../../shared/vocabulary.js'
import { DELIVERY_FACTS, nextState, type Facts, type Move } from './transitions.js'

type Db = Kysely<Database> | Transaction<Database>

/** The moves a rephrase run in flight holds back: each fixes the description it reads. */
const HELD_BY_REPHRASE: readonly Move[] = ['draft_spec', 'redraft', 'approve']

/**
 * What a move's destination can depend on (`Facts`), read where the move is made: the kind of
 * the task's latest run, and whether the task has a spec version.
 */
export async function moveFacts(db: Db, taskId: string): Promise<Facts> {
  const run = await db
    .selectFrom('runs')
    .select('kind')
    .where('task_id', '=', taskId)
    .where('kind', 'in', ['spec', 'delivery'])
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  const spec = await db
    .selectFrom('specs')
    .select('id')
    .where('task_id', '=', taskId)
    .limit(1)
    .executeTakeFirst()
  return { run: run?.kind === 'spec' ? 'spec' : 'delivery', hasSpec: spec !== undefined }
}

/**
 * The only writer of `tasks.state`. The row is locked first, so two movers — the owner's tab
 * and the runner — are serialised, and the loser gets a 409 rather than a lost update. A move
 * whose destination depends on the run's kind or on a spec existing takes `facts`.
 */
export async function moveTask(
  db: Db,
  taskId: string,
  move: Move,
  facts: Facts = DELIVERY_FACTS,
): Promise<{ from: TaskState; to: TaskState }> {
  const task = await db
    .selectFrom('tasks')
    .select(['state', 'project_id'])
    .where('id', '=', taskId)
    .forUpdate()
    .executeTakeFirst()
  if (task === undefined) throw new NotFoundError('No such task')

  const to = nextState(task.state, move, facts)
  if (to === undefined) {
    throw new ConflictError(`A task in ${task.state} cannot ${move.replaceAll('_', ' ')}`, {
      state: task.state,
      move,
    })
  }

  if (HELD_BY_REPHRASE.includes(move)) {
    const rephrasing = await db
      .selectFrom('runs')
      .select('id')
      .where('task_id', '=', taskId)
      .where('kind', '=', 'rephrase')
      .where('status', 'in', ['queued', 'running'])
      .limit(1)
      .executeTakeFirst()
    if (rephrasing !== undefined)
      throw new ConflictError('The description is being rephrased; wait for it or cancel it', {
        reason: 'rephrasing',
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
