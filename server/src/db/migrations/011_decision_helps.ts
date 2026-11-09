import { Kysely, sql } from 'kysely'

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

// Repeated here rather than imported, as in 001: a migration records what was applied.
const RUN_KINDS_BEFORE = ['spec', 'delivery', 'title', 'rephrase']
const RUN_KINDS = ['spec', 'delivery', 'title', 'rephrase', 'help']
const HELP_MODES_BEFORE = ['suggest', 'explain']
const HELP_MODES = ['suggest', 'explain', 'review', 'restate', 'recommend', 'check']

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
  await replaceCheck(db, 'runs', 'runs_kind_known', sql`kind in (${list(RUN_KINDS)})`)

  await db.schema
    .alterTable('helps')
    .addColumn('decision', 'text', (col) => col.notNull().defaultTo('question'))
    .addColumn('subject', 'jsonb')
    .addColumn('retired_at', 'timestamptz')
    .execute()
  // Existing rows are question helps; a new row names its decision.
  await sql`alter table helps alter column decision drop default`.execute(db)
  await sql`alter table helps alter column approval_id drop not null`.execute(db)

  await replaceCheck(db, 'helps', 'helps_mode_known', sql`mode in (${list(HELP_MODES)})`)
  await sql`alter table helps add constraint helps_decision_known
    check (decision in ('question', 'spec_review', 'stopped_run', 'mark_done'))`.execute(db)
  await sql`alter table helps add constraint helps_approval_iff_question
    check ((approval_id is not null) = (decision = 'question'))`.execute(db)
  await sql`alter table helps add constraint helps_mode_of_decision
    check ((decision = 'question' and mode in ('suggest', 'explain'))
      or (decision = 'spec_review' and mode in ('review', 'restate'))
      or (decision = 'stopped_run' and mode = 'recommend')
      or (decision = 'mark_done' and mode = 'check'))`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse rather than delete: a decision help and its run carry events and cost that would be lost.
  const { rows } = await sql<{ n: string }>`select (
      (select count(*) from helps where decision <> 'question')
      + (select count(*) from runs where kind = 'help'))::text as n`.execute(db)
  if (Number(rows[0]?.n ?? 0) > 0) {
    throw new Error(
      'Cannot roll back 011: decision helps exist, and removing them would lose their phases, events and cost.',
    )
  }
  await sql`alter table helps drop constraint helps_mode_of_decision`.execute(db)
  await sql`alter table helps drop constraint helps_approval_iff_question`.execute(db)
  await sql`alter table helps drop constraint helps_decision_known`.execute(db)
  await replaceCheck(db, 'helps', 'helps_mode_known', sql`mode in (${list(HELP_MODES_BEFORE)})`)
  await sql`alter table helps alter column approval_id set not null`.execute(db)
  await db.schema
    .alterTable('helps')
    .dropColumn('retired_at')
    .dropColumn('subject')
    .dropColumn('decision')
    .execute()
  await replaceCheck(db, 'runs', 'runs_kind_known', sql`kind in (${list(RUN_KINDS_BEFORE)})`)
}
