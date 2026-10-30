import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('project_test_commands')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('project_id', 'uuid', (col) =>
      col.notNull().references('projects.id').onDelete('cascade'),
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('command', 'text', (col) => col.notNull())
    .addColumn('is_default', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
  await sql`create unique index project_test_commands_name
    on project_test_commands (project_id, lower(name))`.execute(db)
  await sql`create unique index project_test_commands_default
    on project_test_commands (project_id) where is_default`.execute(db)

  await sql`insert into project_test_commands (project_id, name, command, is_default)
    select id, 'tests', test_command, true from projects`.execute(db)

  await db.schema
    .alterTable('tasks')
    .addColumn('test_command_id', 'uuid', (col) =>
      col.references('project_test_commands.id').onDelete('set null'),
    )
    .execute()
  await db.schema.alterTable('runs').addColumn('test_command', 'text').execute()
  await sql`update runs set test_command = c.command
    from tasks t join project_test_commands c on c.project_id = t.project_id and c.is_default
    where runs.task_id = t.id and runs.kind = 'delivery' and runs.started_at is not null`.execute(
    db,
  )

  await db.schema.alterTable('projects').dropColumn('test_command').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('projects').addColumn('test_command', 'text').execute()
  await sql`update projects set test_command = coalesce(
    (select command from project_test_commands c
      where c.project_id = projects.id and c.is_default), 'npm test')`.execute(db)
  await db.schema
    .alterTable('projects')
    .alterColumn('test_command', (col) => col.setNotNull())
    .execute()
  await db.schema.alterTable('tasks').dropColumn('test_command_id').execute()
  await db.schema.alterTable('runs').dropColumn('test_command').execute()
  await db.schema.dropTable('project_test_commands').execute()
}
