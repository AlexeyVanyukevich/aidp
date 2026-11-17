import { Kysely, sql } from 'kysely'

// Repeated here rather than imported, as in 001: a migration records what was applied. The lists
// are 014's plus this migration's value only.
const HELP_MODES_BEFORE = [
  'suggest',
  'explain',
  'review',
  'restate',
  'recommend',
  'check',
  'advise',
  'code_review',
  'suggest_all',
]
const HELP_MODES = [...HELP_MODES_BEFORE, 'review_plan']

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

async function replaceCheck(
  db: Kysely<any>,
  name: string,
  condition: ReturnType<typeof sql>,
): Promise<void> {
  await sql`alter table helps drop constraint ${sql.ref(name)}`.execute(db)
  await sql`alter table helps add constraint ${sql.ref(name)} check (${condition})`.execute(db)
}

const decisionCheck = (questionModes: string) => sql`
  (decision = 'question' and mode in (${sql.raw(questionModes)}))
  or (decision = 'spec_review' and mode in ('review', 'restate'))
  or (decision = 'stopped_run' and mode = 'recommend')
  or (decision = 'mark_done' and mode = 'check')
  or (decision = 'proposal' and mode = 'advise')
  or (decision = 'pull_request' and mode = 'code_review')`

export async function up(db: Kysely<any>): Promise<void> {
  await replaceCheck(db, 'helps_mode_known', sql`mode in (${list(HELP_MODES)})`)
  await replaceCheck(
    db,
    'helps_mode_of_decision',
    decisionCheck(`'suggest', 'explain', 'suggest_all', 'review_plan'`),
  )
  // A result of the old shape (a verdict of nothing_to_change, findings without a destination)
  // is never shown again: retire every succeeded review of the two decisions that had one.
  await sql`update helps set retired_at = now()
    where status = 'succeeded' and mode in ('review', 'code_review') and retired_at is null`.execute(
    db,
  )
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse rather than delete: a help carries its run, phases, events and cost.
  const { rows } = await sql<{
    n: string
  }>`select count(*)::text as n from helps where mode = 'review_plan'`.execute(db)
  if (Number(rows[0]?.n ?? 0) > 0) {
    throw new Error(
      'Cannot roll back 015: plan reviews exist, and removing them would lose their phases, events and cost.',
    )
  }
  await replaceCheck(
    db,
    'helps_mode_of_decision',
    decisionCheck(`'suggest', 'explain', 'suggest_all'`),
  )
  await replaceCheck(db, 'helps_mode_known', sql`mode in (${list(HELP_MODES_BEFORE)})`)
}
