import { Kysely, sql } from 'kysely'

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

const TASK_STATES = [
  'backlog',
  'spec_draft',
  'spec_review',
  'ready',
  'running',
  'needs_approval',
  'review',
  'done',
  'blocked',
  'failed',
]
const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
const PHASE_NAMES = ['spec', 'plan', 'build', 'verify']
const EVENT_TYPES = [
  'phase_start',
  'phase_end',
  'message',
  'tool_call',
  'subagent_start',
  'subagent_stop',
  'approval_requested',
  'approval_answered',
  'checkpoint',
  'error',
  'run_end',
]

// The vocabularies are repeated here rather than imported from schema.ts: a migration is a
// record of what was applied, and must not change when the code's lists grow later.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('projects')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('key', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('repo_path', 'text', (col) => col.notNull().unique())
    .addColumn('github_repo', 'text', (col) => col.notNull())
    .addColumn('base_branch', 'text', (col) => col.notNull())
    .addColumn('test_command', 'text', (col) => col.notNull())
    .addColumn('next_task_number', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('projects_key_shape', sql`key ~ '^[A-Z][A-Z0-9]{1,9}$'`)
    .addCheckConstraint('projects_repo_shape', sql`github_repo ~ '^[^/\\s]+/[^/\\s]+$'`)
    .execute()

  await db.schema
    .createTable('tasks')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('project_id', 'uuid', (col) => col.notNull().references('projects.id'))
    .addColumn('number', 'integer', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('description_md', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('state', 'text', (col) => col.notNull())
    .addColumn('position', 'double precision', (col) => col.notNull())
    .addColumn('budget_usd', 'numeric(10, 2)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('tasks_number_unique', ['project_id', 'number'])
    .addCheckConstraint('tasks_state_known', sql`state in (${list(TASK_STATES)})`)
    .addCheckConstraint('tasks_title_not_blank', sql`length(btrim(title)) > 0`)
    .addCheckConstraint('tasks_budget_positive', sql`budget_usd is null or budget_usd > 0`)
    .execute()

  await db.schema
    .createTable('specs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('task_id', 'uuid', (col) => col.notNull().references('tasks.id').onDelete('cascade'))
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('body_md', 'text', (col) => col.notNull())
    .addColumn('criteria', 'jsonb')
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('approved_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('specs_version_unique', ['task_id', 'version'])
    .addCheckConstraint('specs_status_known', sql`status in ('draft', 'approved', 'superseded')`)
    .execute()

  await db.schema
    .createTable('runs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('task_id', 'uuid', (col) => col.notNull().references('tasks.id').onDelete('cascade'))
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('spec_version', 'integer', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('current_phase', 'text')
    .addColumn('branch', 'text')
    .addColumn('worktree_path', 'text')
    .addColumn('pr_number', 'integer')
    .addColumn('pr_url', 'text')
    .addColumn('fix_loops', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('failure_reason', 'text')
    .addColumn('runner_id', 'text')
    .addColumn('cancel_requested', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('started_at', 'timestamptz')
    .addColumn('ended_at', 'timestamptz')
    .addColumn('last_heartbeat_at', 'timestamptz')
    .addCheckConstraint('runs_kind_known', sql`kind in ('spec', 'delivery')`)
    .addCheckConstraint('runs_status_known', sql`status in (${list(RUN_STATUSES)})`)
    .addCheckConstraint(
      'runs_phase_known',
      sql`current_phase is null or current_phase in (${list(PHASE_NAMES)})`,
    )
    .execute()
  await db.schema.createIndex('runs_queued').on('runs').columns(['status', 'created_at']).execute()

  await db.schema
    .createTable('run_tokens')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('run_id', 'uuid', (col) => col.notNull().references('runs.id').onDelete('cascade'))
    .addColumn('token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createTable('phases')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('run_id', 'uuid', (col) => col.notNull().references('runs.id').onDelete('cascade'))
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('attempt', 'integer', (col) => col.notNull())
    .addColumn('agent', 'text', (col) => col.notNull())
    .addColumn('model', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('session_id', 'uuid')
    .addColumn('summary_md', 'text')
    .addColumn('reported_cost', 'jsonb')
    .addColumn('started_at', 'timestamptz', (col) => col.notNull())
    .addColumn('ended_at', 'timestamptz')
    .addCheckConstraint('phases_name_known', sql`name in (${list(PHASE_NAMES)})`)
    .addCheckConstraint('phases_status_known', sql`status in ('running', 'succeeded', 'failed')`)
    .execute()

  await db.schema
    .createTable('events')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('run_id', 'uuid', (col) => col.notNull().references('runs.id').onDelete('cascade'))
    .addColumn('phase_id', 'uuid')
    .addColumn('ts', 'timestamptz', (col) => col.notNull())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('agent', 'text')
    .addColumn('model', 'text')
    .addColumn('tool', 'text')
    .addColumn('target', 'text')
    .addColumn('status', 'text')
    .addColumn('duration_ms', 'integer')
    .addColumn('input', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('output', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('cache_read', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('cache_write', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('received_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('events_type_known', sql`type in (${list(EVENT_TYPES)})`)
    .addCheckConstraint(
      'events_usage_not_negative',
      sql`input >= 0 and output >= 0 and cache_read >= 0 and cache_write >= 0`,
    )
    .execute()
  await db.schema
    .createIndex('events_by_run')
    .on('events')
    .columns(['run_id', 'ts', 'id'])
    .execute()
  await db.schema.createIndex('events_by_phase').on('events').column('phase_id').execute()

  await db.schema
    .createTable('approval_requests')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('run_id', 'uuid', (col) => col.notNull().references('runs.id').onDelete('cascade'))
    .addColumn('phase_id', 'uuid')
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('question', 'text', (col) => col.notNull())
    .addColumn('options', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('recommendation', 'text')
    .addColumn('context_md', 'text')
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('answer', 'jsonb')
    .addColumn('checkpoint', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('answered_at', 'timestamptz')
    .addCheckConstraint('approvals_status_known', sql`status in ('open', 'answered', 'expired')`)
    .execute()

  await db.schema
    .createTable('artifacts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('run_id', 'uuid', (col) => col.notNull().references('runs.id').onDelete('cascade'))
    .addColumn('phase_id', 'uuid')
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('body_md', 'text', (col) => col.notNull())
    .addColumn('uri', 'text')
    .addColumn('data', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('artifacts_kind_known', sql`kind in ('plan', 'verify_report', 'pr')`)
    .execute()

  await db.schema
    .createTable('prices')
    .addColumn('model', 'text', (col) => col.notNull())
    .addColumn('effective_from', 'date', (col) => col.notNull())
    .addColumn('input', 'numeric(12, 6)', (col) => col.notNull())
    .addColumn('output', 'numeric(12, 6)', (col) => col.notNull())
    .addColumn('cache_read', 'numeric(12, 6)', (col) => col.notNull())
    .addColumn('cache_write', 'numeric(12, 6)', (col) => col.notNull())
    .addPrimaryKeyConstraint('prices_pk', ['model', 'effective_from'])
    .addCheckConstraint(
      'prices_not_negative',
      sql`input >= 0 and output >= 0 and cache_read >= 0 and cache_write >= 0`,
    )
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of [
    'prices',
    'artifacts',
    'approval_requests',
    'events',
    'phases',
    'run_tokens',
    'runs',
    'specs',
    'tasks',
    'projects',
  ]) {
    await db.schema.dropTable(table).execute()
  }
}
