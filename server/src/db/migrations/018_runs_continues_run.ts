import type { Kysely } from 'kysely'

// The number of the delivery run a send-back continues, among the same task's runs.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('runs').addColumn('continues_run', 'integer').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('runs').dropColumn('continues_run').execute()
}
