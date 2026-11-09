import { Kysely, sql } from 'kysely'

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

// Repeated here rather than imported, as in 001: a migration records what was applied.
const RUN_KINDS_BEFORE = ['spec', 'delivery', 'title']
const RUN_KINDS = ['spec', 'delivery', 'title', 'rephrase']
const RUN_PHASES_BEFORE = ['spec', 'plan', 'build', 'verify', 'title']
const RUN_PHASES = ['spec', 'plan', 'build', 'verify', 'title', 'rephrase']
const PHASE_NAMES_BEFORE = ['spec', 'plan', 'build', 'verify', 'title', 'help']
const PHASE_NAMES = ['spec', 'plan', 'build', 'verify', 'title', 'help', 'rephrase']
const SUGGESTION_STATUSES = ['pending', 'accepted', 'discarded', 'replaced']

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

const phaseCurrent = (names: readonly string[]) =>
  sql`current_phase is null or current_phase in (${list(names)})`

export async function up(db: Kysely<any>): Promise<void> {
  await replaceCheck(db, 'runs', 'runs_kind_known', sql`kind in (${list(RUN_KINDS)})`)
  await replaceCheck(db, 'runs', 'runs_phase_known', phaseCurrent(RUN_PHASES))
  await replaceCheck(db, 'phases', 'phases_name_known', sql`name in (${list(PHASE_NAMES)})`)

  await db.schema
    .alterTable('runs')
    .addColumn('base_md', 'text')
    .addColumn('suggestion_md', 'text')
    .addColumn('suggestion_status', 'text')
    .addColumn('suggestion_decided_at', 'timestamptz')
    .execute()
  await sql`alter table runs add constraint runs_suggestion_status_known
    check (suggestion_status is null or suggestion_status in (${list(SUGGESTION_STATUSES)}))`.execute(
    db,
  )
  await sql`alter table runs add constraint runs_suggestion_only_rephrase
    check (kind = 'rephrase' or (base_md is null and suggestion_md is null
      and suggestion_status is null and suggestion_decided_at is null))`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse rather than delete: a rephrase run carries events and cost that would be lost.
  const { rows } = await sql<{ n: string }>`select count(*)::text as n from runs
    where kind = 'rephrase'`.execute(db)
  if (Number(rows[0]?.n ?? 0) > 0) {
    throw new Error(
      'Cannot roll back 010: rephrase runs exist, and removing them would lose their phases, events and cost.',
    )
  }
  await sql`alter table runs drop constraint runs_suggestion_only_rephrase`.execute(db)
  await sql`alter table runs drop constraint runs_suggestion_status_known`.execute(db)
  await db.schema
    .alterTable('runs')
    .dropColumn('suggestion_decided_at')
    .dropColumn('suggestion_status')
    .dropColumn('suggestion_md')
    .dropColumn('base_md')
    .execute()
  await replaceCheck(db, 'phases', 'phases_name_known', sql`name in (${list(PHASE_NAMES_BEFORE)})`)
  await replaceCheck(db, 'runs', 'runs_phase_known', phaseCurrent(RUN_PHASES_BEFORE))
  await replaceCheck(db, 'runs', 'runs_kind_known', sql`kind in (${list(RUN_KINDS_BEFORE)})`)
}
