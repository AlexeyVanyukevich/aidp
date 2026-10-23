import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  // A spec run's version is the one it redrafts, and a first draft has none; a delivery run
  // always carries the approved version it delivers.
  await sql`alter table runs alter column spec_version drop not null`.execute(db)
  await sql`alter table runs add constraint runs_delivery_has_spec
    check (kind <> 'delivery' or spec_version is not null)`.execute(db)
  await db.schema
    .alterTable('runs')
    .addColumn('note', 'text')
    .addColumn('number', 'integer')
    .execute()
  // Drafts and delivery runs are numbered apart, each in the order it was created.
  await sql`update runs set number = numbered.number from (
      select id, row_number() over (partition by task_id, kind order by created_at, id) as number
      from runs
    ) as numbered
    where runs.id = numbered.id`.execute(db)
  await sql`alter table runs alter column number set not null`.execute(db)

  await db.schema
    .alterTable('specs')
    .addColumn('run_id', 'uuid', (col) => col.references('runs.id').onDelete('set null'))
    .execute()

  await db.schema.alterTable('approval_requests').addColumn('questions', 'jsonb').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('approval_requests').dropColumn('questions').execute()
  // Slice 2 knows no batch: one left open would be unanswerable.
  await sql`update approval_requests set status = 'withdrawn'
    where kind = 'questions' and status in ('open', 'expired')`.execute(db)
  await db.schema.alterTable('specs').dropColumn('run_id').execute()
  await db.schema.alterTable('runs').dropColumn('number').dropColumn('note').execute()
  await sql`alter table runs drop constraint runs_delivery_has_spec`.execute(db)
  // Slice 2 needs every run to carry a version. A first draft has none; 0, which no spec has,
  // keeps its phases, events and costs rather than deleting them.
  await sql`update runs set spec_version = 0 where spec_version is null`.execute(db)
  await sql`alter table runs alter column spec_version set not null`.execute(db)
}
