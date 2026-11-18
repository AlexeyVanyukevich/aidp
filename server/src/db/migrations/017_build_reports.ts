import { Kysely, sql } from 'kysely'

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

// Repeated here rather than imported, as in 001: a migration records what was applied.
const ARTIFACT_KINDS_BEFORE = ['plan', 'verify_report', 'pr', 'title']
const ARTIFACT_KINDS = ['plan', 'verify_report', 'pr', 'title', 'build_report']

async function replaceKinds(db: Kysely<any>, kinds: readonly string[]): Promise<void> {
  await sql`alter table artifacts drop constraint artifacts_kind_known`.execute(db)
  await sql`alter table artifacts add constraint artifacts_kind_known
    check (kind in (${list(kinds)}))`.execute(db)
}

export async function up(db: Kysely<any>): Promise<void> {
  await replaceKinds(db, ARTIFACT_KINDS)
}

export async function down(db: Kysely<any>): Promise<void> {
  // A build report has no place before this migration: it goes.
  await sql`delete from artifacts where kind = 'build_report'`.execute(db)
  await replaceKinds(db, ARTIFACT_KINDS_BEFORE)
}
