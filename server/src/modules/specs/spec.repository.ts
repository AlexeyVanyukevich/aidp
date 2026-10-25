import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { SpecCriterion } from '../../shared/vocabulary.js'

export interface SpecRow {
  id: string
  task_id: string
  version: number
  body_md: string
  status: 'draft' | 'approved' | 'superseded'
  approved_at: Date | null
}

type Db = Kysely<Database> | Transaction<Database>
const COLUMNS = ['id', 'task_id', 'version', 'body_md', 'status', 'approved_at'] as const

export class SpecRepository {
  constructor(private readonly db: Kysely<Database>) {}

  list(taskId: string): Promise<SpecRow[]> {
    return this.db
      .selectFrom('specs')
      .select(COLUMNS)
      .where('task_id', '=', taskId)
      .orderBy('version', 'desc')
      .execute()
  }

  get(db: Db, id: string): Promise<SpecRow | undefined> {
    return db
      .selectFrom('specs')
      .select(COLUMNS)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
  }

  async latestVersion(db: Db, taskId: string): Promise<number> {
    const row = await db
      .selectFrom('specs')
      .select((eb) => eb.fn.max('version').as('version'))
      .where('task_id', '=', taskId)
      .executeTakeFirst()
    return row?.version ?? 0
  }

  async insertVersion(db: Db, taskId: string, body: string): Promise<SpecRow> {
    const version = (await this.latestVersion(db, taskId)) + 1
    await db
      .updateTable('specs')
      .set({ status: 'superseded' })
      .where('task_id', '=', taskId)
      .where('status', '=', 'draft')
      .execute()
    return db
      .insertInto('specs')
      .values({
        task_id: taskId,
        version,
        body_md: body,
        status: 'draft',
        criteria: null,
        approved_at: null,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow()
  }

  /**
   * A spec run's save (slice 3 spec, §7): its first inserts the next version, superseding
   * earlier drafts as a hand save does; each later save rewrites that version.
   */
  async saveForRun(db: Db, taskId: string, runId: string, body: string): Promise<SpecRow> {
    const own = await db
      .updateTable('specs')
      .set({ body_md: body })
      .where('run_id', '=', runId)
      .where('status', '=', 'draft')
      .returning(COLUMNS)
      .executeTakeFirst()
    if (own !== undefined) return own
    const row = await this.insertVersion(db, taskId, body)
    await db.updateTable('specs').set({ run_id: runId }).where('id', '=', row.id).execute()
    return row
  }

  async approve(db: Db, id: string, criteria: SpecCriterion[], at: Date): Promise<void> {
    await db
      .updateTable('specs')
      .set({ status: 'approved', criteria: JSON.stringify(criteria), approved_at: at })
      .where('id', '=', id)
      .execute()
  }
}
