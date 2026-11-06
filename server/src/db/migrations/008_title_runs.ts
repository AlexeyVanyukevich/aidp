import { Kysely, sql } from 'kysely'

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

// Repeated here rather than imported, as in 001: a migration records what was applied.
const RUN_KINDS_BEFORE = ['spec', 'delivery']
const RUN_KINDS = ['spec', 'delivery', 'title']
const PHASE_NAMES_BEFORE = ['spec', 'plan', 'build', 'verify']
const PHASE_NAMES = ['spec', 'plan', 'build', 'verify', 'title']
const ARTIFACT_KINDS_BEFORE = ['plan', 'verify_report', 'pr']
const ARTIFACT_KINDS = ['plan', 'verify_report', 'pr', 'title']

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
  await replaceCheck(db, 'runs', 'runs_phase_known', phaseCurrent(PHASE_NAMES))
  await replaceCheck(db, 'phases', 'phases_name_known', sql`name in (${list(PHASE_NAMES)})`)
  await replaceCheck(
    db,
    'artifacts',
    'artifacts_kind_known',
    sql`kind in (${list(ARTIFACT_KINDS)})`,
  )
}

export async function down(db: Kysely<any>): Promise<void> {
  // A title run has no place before this migration: it goes, with everything that hangs on it.
  const titleRuns = sql`select id from runs where kind = 'title'`
  await sql`delete from events where run_id in (${titleRuns})`.execute(db)
  await sql`delete from phases where run_id in (${titleRuns})`.execute(db)
  await sql`delete from artifacts where run_id in (${titleRuns})`.execute(db)
  await sql`delete from run_tokens where run_id in (${titleRuns})`.execute(db)
  await sql`delete from approval_requests where run_id in (${titleRuns})`.execute(db)
  await sql`delete from runs where kind = 'title'`.execute(db)

  await replaceCheck(
    db,
    'artifacts',
    'artifacts_kind_known',
    sql`kind in (${list(ARTIFACT_KINDS_BEFORE)})`,
  )
  await replaceCheck(db, 'phases', 'phases_name_known', sql`name in (${list(PHASE_NAMES_BEFORE)})`)
  await replaceCheck(db, 'runs', 'runs_phase_known', phaseCurrent(PHASE_NAMES_BEFORE))
  await replaceCheck(db, 'runs', 'runs_kind_known', sql`kind in (${list(RUN_KINDS_BEFORE)})`)
}
