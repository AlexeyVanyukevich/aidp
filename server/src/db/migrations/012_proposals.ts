import { Kysely, sql } from 'kysely'

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

// Repeated here rather than imported, as in 001: a migration records what was applied.
const HELP_MODES_BEFORE = ['suggest', 'explain', 'review', 'restate', 'recommend', 'check']
const HELP_MODES = [...HELP_MODES_BEFORE, 'advise']
const OUTCOMES = ['file', 'workaround', 'wait', 'dismiss']

async function replaceCheck(
  db: Kysely<any>,
  table: string,
  name: string,
  condition: ReturnType<typeof sql>,
): Promise<void> {
  await sql`alter table ${sql.table(table)} drop constraint ${sql.ref(name)}`.execute(db)
  await sql`alter table ${sql.table(table)} add constraint ${sql.ref(name)}
    check (${condition})`.execute(db)
}

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('proposals')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('run_id', 'uuid', (col) => col.notNull().references('runs.id').onDelete('cascade'))
    .addColumn('phase_id', 'uuid', (col) =>
      col.notNull().references('phases.id').onDelete('cascade'),
    )
    // The proposing task, and the project the finding is proposed to.
    .addColumn('task_id', 'uuid', (col) => col.notNull().references('tasks.id').onDelete('cascade'))
    .addColumn('project_id', 'uuid', (col) => col.notNull().references('projects.id'))
    .addColumn('number', 'integer', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('description_md', 'text', (col) => col.notNull())
    .addColumn('related', 'boolean', (col) => col.notNull())
    .addColumn('bearing_md', 'text')
    .addColumn('workaround_md', 'text')
    .addColumn('approval_id', 'uuid', (col) =>
      col.unique().references('approval_requests.id').onDelete('cascade'),
    )
    .addColumn('outcome', 'text')
    .addColumn('filed_task_id', 'uuid', (col) => col.references('tasks.id'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('settled_at', 'timestamptz')
    .addUniqueConstraint('proposals_number_per_run', ['run_id', 'number'])
    .addCheckConstraint('proposals_number_known', sql`number between 1 and 10`)
    .addCheckConstraint('proposals_title_known', sql`char_length(btrim(title)) between 1 and 200`)
    .addCheckConstraint(
      'proposals_outcome_known',
      sql`outcome is null or outcome in (${list(OUTCOMES)})`,
    )
    .addCheckConstraint(
      'proposals_outcome_iff_settled',
      sql`(outcome is null) = (settled_at is null)`,
    )
    .addCheckConstraint(
      'proposals_filed_task_iff_filed',
      sql`(filed_task_id is not null) = coalesce(outcome in ('file', 'workaround', 'wait'), false)`,
    )
    .addCheckConstraint('proposals_approval_iff_related', sql`(approval_id is not null) = related`)
    .addCheckConstraint('proposals_related_has_bearing', sql`not related or bearing_md is not null`)
    .addCheckConstraint('proposals_workaround_needs_related', sql`workaround_md is null or related`)
    .addCheckConstraint(
      'proposals_workaround_outcome_needs_text',
      sql`outcome is distinct from 'workaround' or workaround_md is not null`,
    )
    .execute()
  await db.schema.createIndex('proposals_by_task').on('proposals').column('task_id').execute()
  await db.schema.createIndex('proposals_by_project').on('proposals').column('project_id').execute()

  await replaceCheck(db, 'helps', 'helps_mode_known', sql`mode in (${list(HELP_MODES)})`)
  await replaceCheck(
    db,
    'helps',
    'helps_decision_known',
    sql`decision in ('question', 'spec_review', 'stopped_run', 'mark_done', 'proposal')`,
  )
  await replaceCheck(
    db,
    'helps',
    'helps_mode_of_decision',
    sql`(decision = 'question' and mode in ('suggest', 'explain'))
      or (decision = 'spec_review' and mode in ('review', 'restate'))
      or (decision = 'stopped_run' and mode = 'recommend')
      or (decision = 'mark_done' and mode = 'check')
      or (decision = 'proposal' and mode = 'advise')`,
  )
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse rather than delete: a proposal and its help carry the owner's pending decision.
  const { rows } = await sql<{ n: string }>`select (
      (select count(*) from proposals)
      + (select count(*) from helps where decision = 'proposal'))::text as n`.execute(db)
  if (Number(rows[0]?.n ?? 0) > 0) {
    throw new Error('Cannot roll back 012: proposals or their helps exist, and would be lost.')
  }
  await replaceCheck(
    db,
    'helps',
    'helps_mode_of_decision',
    sql`(decision = 'question' and mode in ('suggest', 'explain'))
      or (decision = 'spec_review' and mode in ('review', 'restate'))
      or (decision = 'stopped_run' and mode = 'recommend')
      or (decision = 'mark_done' and mode = 'check')`,
  )
  await replaceCheck(
    db,
    'helps',
    'helps_decision_known',
    sql`decision in ('question', 'spec_review', 'stopped_run', 'mark_done')`,
  )
  await replaceCheck(db, 'helps', 'helps_mode_known', sql`mode in (${list(HELP_MODES_BEFORE)})`)
  await db.schema.dropTable('proposals').execute()
}
