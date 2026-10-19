import { Kysely, sql } from 'kysely'

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

// Repeated here rather than imported, as in 001: a migration records what was applied.
const RUN_STATUSES_BEFORE = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
const RUN_STATUSES = ['queued', 'running', 'paused', 'blocked', 'succeeded', 'failed', 'cancelled']
const PHASE_STATUSES_BEFORE = ['running', 'succeeded', 'failed']
const PHASE_STATUSES = ['running', 'paused', 'succeeded', 'failed']
const APPROVAL_STATUSES_BEFORE = ['open', 'answered', 'expired']
const APPROVAL_STATUSES = ['open', 'answered', 'expired', 'withdrawn']

async function replaceCheck(
  db: Kysely<any>,
  table: string,
  name: string,
  column: string,
  values: string[],
): Promise<void> {
  await sql`alter table ${sql.table(table)} drop constraint ${sql.ref(name)}`.execute(db)
  await sql`alter table ${sql.table(table)} add constraint ${sql.ref(name)}
    check (${sql.ref(column)} in (${list(values)}))`.execute(db)
}

export async function up(db: Kysely<any>): Promise<void> {
  await replaceCheck(db, 'runs', 'runs_status_known', 'status', RUN_STATUSES)
  await db.schema
    .alterTable('runs')
    .addColumn('checkpoint', 'jsonb')
    .addColumn('block', 'jsonb')
    .addColumn('pending', 'text')
    .addColumn('resume_message', 'text')
    .addColumn('queued_at', 'timestamptz')
    .execute()
  await sql`alter table runs add constraint runs_pending_known
    check (pending is null or pending in ('resume', 'cleanup'))`.execute(db)
  // Runs already waiting keep their place in the queue.
  await sql`update runs set queued_at = created_at where status = 'queued'`.execute(db)
  await db.schema
    .createIndex('runs_queue')
    .on('runs')
    .column('queued_at')
    .where(sql.ref('queued_at'), 'is not', null)
    .execute()

  await replaceCheck(db, 'phases', 'phases_status_known', 'status', PHASE_STATUSES)
  await db.schema
    .alterTable('phases')
    .addColumn('interrupted', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute()

  await replaceCheck(db, 'approval_requests', 'approvals_status_known', 'status', APPROVAL_STATUSES)
  await db.schema.alterTable('approval_requests').addColumn('files', 'jsonb').execute()
  await db.schema
    .createIndex('approvals_by_status')
    .on('approval_requests')
    .columns(['status', 'created_at'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('approvals_by_status').execute()
  await db.schema.alterTable('approval_requests').dropColumn('files').execute()
  await sql`update approval_requests set status = 'expired' where status = 'withdrawn'`.execute(db)
  await replaceCheck(
    db,
    'approval_requests',
    'approvals_status_known',
    'status',
    APPROVAL_STATUSES_BEFORE,
  )

  await db.schema.alterTable('phases').dropColumn('interrupted').execute()
  await sql`update phases set status = 'failed' where status = 'paused'`.execute(db)
  await replaceCheck(db, 'phases', 'phases_status_known', 'status', PHASE_STATUSES_BEFORE)

  await db.schema.dropIndex('runs_queue').execute()
  await sql`alter table runs drop constraint runs_pending_known`.execute(db)
  await db.schema
    .alterTable('runs')
    .dropColumn('queued_at')
    .dropColumn('resume_message')
    .dropColumn('pending')
    .dropColumn('block')
    .dropColumn('checkpoint')
    .execute()
  // Slice 1 knows no pause: a paused or blocked run becomes the failure it would have been.
  await sql`update runs set status = 'failed' where status in ('paused', 'blocked')`.execute(db)
  await replaceCheck(db, 'runs', 'runs_status_known', 'status', RUN_STATUSES_BEFORE)
}
