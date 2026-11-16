import { Kysely, sql } from 'kysely'

// Repeated here rather than imported, as in 001: a migration records what was applied. The lists
// are 013's plus this migration's value only.
const HELP_MODES_BEFORE = [
  'suggest',
  'explain',
  'review',
  'restate',
  'recommend',
  'check',
  'advise',
  'code_review',
]
const HELP_MODES = [...HELP_MODES_BEFORE, 'suggest_all']

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

async function replaceCheck(
  db: Kysely<any>,
  name: string,
  condition: ReturnType<typeof sql>,
): Promise<void> {
  await sql`alter table helps drop constraint ${sql.ref(name)}`.execute(db)
  await sql`alter table helps add constraint ${sql.ref(name)} check (${condition})`.execute(db)
}

export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table projects add column batch_suggest text not null default 'whole'
    constraint projects_batch_suggest_known check (batch_suggest in ('whole', 'one'))`.execute(db)
  await replaceCheck(db, 'helps_mode_known', sql`mode in (${list(HELP_MODES)})`)
  await replaceCheck(
    db,
    'helps_mode_of_decision',
    sql`(decision = 'question' and mode in ('suggest', 'explain', 'suggest_all'))
      or (decision = 'spec_review' and mode in ('review', 'restate'))
      or (decision = 'stopped_run' and mode = 'recommend')
      or (decision = 'mark_done' and mode = 'check')
      or (decision = 'proposal' and mode = 'advise')
      or (decision = 'pull_request' and mode = 'code_review')`,
  )
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse rather than delete: a help carries its run, phases, events and cost.
  const { rows } = await sql<{
    n: string
  }>`select count(*)::text as n from helps where mode = 'suggest_all'`.execute(db)
  if (Number(rows[0]?.n ?? 0) > 0) {
    throw new Error(
      'Cannot roll back 014: whole-batch suggestions exist, and removing them would lose their phases, events and cost.',
    )
  }
  await replaceCheck(
    db,
    'helps_mode_of_decision',
    sql`(decision = 'question' and mode in ('suggest', 'explain'))
      or (decision = 'spec_review' and mode in ('review', 'restate'))
      or (decision = 'stopped_run' and mode = 'recommend')
      or (decision = 'mark_done' and mode = 'check')
      or (decision = 'proposal' and mode = 'advise')
      or (decision = 'pull_request' and mode = 'code_review')`,
  )
  await replaceCheck(db, 'helps_mode_known', sql`mode in (${list(HELP_MODES_BEFORE)})`)
  await sql`alter table projects drop column batch_suggest`.execute(db)
}
