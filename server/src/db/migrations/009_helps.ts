import { Kysely, sql } from 'kysely'

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

// Repeated here rather than imported, as in 001: a migration records what was applied.
const PHASE_NAMES_BEFORE = ['spec', 'plan', 'build', 'verify', 'title']
const PHASE_NAMES = ['spec', 'plan', 'build', 'verify', 'title', 'help']
const HELP_MODES = ['suggest', 'explain']
const HELP_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'stopped']

async function replacePhaseNames(db: Kysely<any>, values: string[]): Promise<void> {
  await sql`alter table phases drop constraint phases_name_known`.execute(db)
  await sql`alter table phases add constraint phases_name_known
    check (name in (${list(values)}))`.execute(db)
}

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('helps')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('run_id', 'uuid', (col) => col.notNull().references('runs.id').onDelete('cascade'))
    .addColumn('approval_id', 'uuid', (col) =>
      col.notNull().references('approval_requests.id').onDelete('cascade'),
    )
    // The question of a batch; null for a single request.
    .addColumn('question_index', 'integer')
    .addColumn('mode', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('result', 'jsonb')
    .addColumn('reason', 'text')
    .addColumn('phase_id', 'uuid')
    .addColumn('runner_id', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('started_at', 'timestamptz')
    .addColumn('ended_at', 'timestamptz')
    .addColumn('last_heartbeat_at', 'timestamptz')
    .addCheckConstraint('helps_mode_known', sql`mode in (${list(HELP_MODES)})`)
    .addCheckConstraint('helps_status_known', sql`status in (${list(HELP_STATUSES)})`)
    .addCheckConstraint(
      'helps_question_index_known',
      sql`question_index is null or question_index >= 0`,
    )
    .execute()
  await db.schema
    .createIndex('helps_by_approval')
    .on('helps')
    .columns(['approval_id', 'created_at'])
    .execute()
  await db.schema
    .createIndex('helps_by_status')
    .on('helps')
    .columns(['status', 'created_at'])
    .execute()

  await db.schema
    .alterTable('run_tokens')
    .addColumn('help_id', 'uuid', (col) => col.references('helps.id').onDelete('cascade'))
    .execute()

  // runs_phase_known is untouched: a Help phase never becomes a run's current phase.
  await replacePhaseNames(db, PHASE_NAMES)
}

export async function down(db: Kysely<any>): Promise<void> {
  // A Help phase cannot outlive its name in the check: its events and tokens go with it.
  await sql`delete from events
    where phase_id in (select id from phases where name = 'help')`.execute(db)
  await sql`delete from phases where name = 'help'`.execute(db)
  await sql`delete from run_tokens where help_id is not null`.execute(db)
  await db.schema.alterTable('run_tokens').dropColumn('help_id').execute()
  await db.schema.dropTable('helps').execute()
  await replacePhaseNames(db, PHASE_NAMES_BEFORE)
}
