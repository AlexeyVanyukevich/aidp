import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'

export interface ProjectView {
  id: string
  key: string
  name: string
  repo_path: string
  github_repo: string
  base_branch: string
  setup_command: string | null
}

export interface TestCommandView {
  id: string
  name: string
  command: string
  is_default: boolean
}

export interface ProjectLinkView {
  key: string
  name: string
  note: string
}

export interface ProjectWithLinks extends ProjectView {
  links: ProjectLinkView[]
  test_commands: TestCommandView[]
}

const COLUMNS = [
  'id',
  'key',
  'name',
  'repo_path',
  'github_repo',
  'base_branch',
  'setup_command',
] as const

const TEST_COMMAND_COLUMNS = ['id', 'name', 'command', 'is_default'] as const

/** The constraint that keeps a project's names unique ignoring case. */
const NAME_INDEX = 'project_test_commands_name'

/** Whether the database refused a name because another command of the project has it. */
export function isTakenName(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505' &&
    (error as { constraint?: string }).constraint === NAME_INDEX
  )
}

export class ProjectRepository {
  constructor(private readonly db: Kysely<Database>) {}

  list(): Promise<ProjectView[]> {
    return this.db.selectFrom('projects').select(COLUMNS).orderBy('key').execute()
  }

  /** Every project with the projects it links to, each ordered by key. */
  async listWithLinks(): Promise<ProjectWithLinks[]> {
    const projects = await this.list()
    const rows = await this.db
      .selectFrom('project_links')
      .innerJoin('projects', 'projects.id', 'project_links.linked_project_id')
      .select(['project_links.project_id', 'projects.key', 'projects.name', 'project_links.note'])
      .orderBy('projects.key')
      .execute()
    const commands = await this.db
      .selectFrom('project_test_commands')
      .select(['project_id', ...TEST_COMMAND_COLUMNS])
      .orderBy(sql`lower(name)`)
      .execute()
    return projects.map((project) => ({
      ...project,
      test_commands: commands
        .filter((row) => row.project_id === project.id)
        .map(({ project_id: _, ...command }) => command),
      links: rows
        .filter((row) => row.project_id === project.id)
        .map(({ key, name, note }) => ({ key, name, note })),
    }))
  }

  /** Whether a link was made: false when it already existed. */
  async addLink(projectId: string, linkedId: string, note: string): Promise<boolean> {
    const result = await this.db
      .insertInto('project_links')
      .values({ project_id: projectId, linked_project_id: linkedId, note })
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst()
    return Number(result.numInsertedOrUpdatedRows ?? 0) > 0
  }

  async removeLink(projectId: string, linkedId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('project_links')
      .where('project_id', '=', projectId)
      .where('linked_project_id', '=', linkedId)
      .executeTakeFirst()
    return Number(result.numDeletedRows) > 0
  }

  byKey(key: string): Promise<ProjectView | undefined> {
    return this.db.selectFrom('projects').select(COLUMNS).where('key', '=', key).executeTakeFirst()
  }

  async exists(key: string, repoPath: string): Promise<'key' | 'repo_path' | undefined> {
    const row = await this.db
      .selectFrom('projects')
      .select(['key', 'repo_path'])
      .where((eb) => eb.or([eb('key', '=', key), eb('repo_path', '=', repoPath)]))
      .executeTakeFirst()
    if (row === undefined) return undefined
    return row.key === key ? 'key' : 'repo_path'
  }

  /** Sets only the fields given, in one statement. */
  update(
    key: string,
    changes: { setup_command?: string | null },
  ): Promise<ProjectView | undefined> {
    return this.db
      .updateTable('projects')
      .set(changes)
      .where('key', '=', key)
      .returning(COLUMNS)
      .executeTakeFirst()
  }

  /** The project and its first default command, in one transaction. */
  insert(input: Omit<ProjectView, 'id'>, command: string): Promise<ProjectView> {
    return this.db.transaction().execute(async (trx) => {
      const project = await trx
        .insertInto('projects')
        .values(input)
        .returning(COLUMNS)
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('project_test_commands')
        .values({ project_id: project.id, name: 'tests', command, is_default: true })
        .execute()
      return project
    })
  }

  async testCommands(projectId: string): Promise<TestCommandView[]> {
    return this.db
      .selectFrom('project_test_commands')
      .select(TEST_COMMAND_COLUMNS)
      .where('project_id', '=', projectId)
      .orderBy(sql`lower(name)`)
      .execute()
  }

  testCommand(projectId: string, id: string): Promise<TestCommandView | undefined> {
    return this.db
      .selectFrom('project_test_commands')
      .select(TEST_COMMAND_COLUMNS)
      .where('project_id', '=', projectId)
      .where('id', '=', id)
      .executeTakeFirst()
  }

  /** Whether another command of the project has the name, ignoring case. */
  async nameTaken(projectId: string, name: string, exceptId?: string): Promise<boolean> {
    let query = this.db
      .selectFrom('project_test_commands')
      .select('id')
      .where('project_id', '=', projectId)
      .where(sql<boolean>`lower(name) = lower(${name})`)
    if (exceptId !== undefined) query = query.where('id', '<>', exceptId)
    return (await query.executeTakeFirst()) !== undefined
  }

  addTestCommand(
    project: { id: string; key: string },
    name: string,
    command: string,
  ): Promise<TestCommandView> {
    return this.db.transaction().execute(async (trx) => {
      const added = await trx
        .insertInto('project_test_commands')
        .values({ project_id: project.id, name, command })
        .returning(TEST_COMMAND_COLUMNS)
        .executeTakeFirstOrThrow()
      await publish(trx, { topic: 'project.updated', key: project.key })
      return added
    })
  }

  /** Sets the fields given; `is_default` moves the default here, clearing the old one. */
  updateTestCommand(
    project: { id: string; key: string },
    id: string,
    changes: { name?: string; command?: string; is_default?: true },
  ): Promise<TestCommandView | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const { is_default, ...fields } = changes
      if (is_default === true) {
        await trx
          .updateTable('project_test_commands')
          .set({ is_default: false })
          .where('project_id', '=', project.id)
          .where('is_default', '=', true)
          .where('id', '<>', id)
          .execute()
      }
      const updated = await trx
        .updateTable('project_test_commands')
        .set({ ...fields, ...(is_default === true ? { is_default: true } : {}) })
        .where('project_id', '=', project.id)
        .where('id', '=', id)
        .returning(TEST_COMMAND_COLUMNS)
        .executeTakeFirst()
      if (updated !== undefined) await publish(trx, { topic: 'project.updated', key: project.key })
      return updated
    })
  }

  /** 'default' when the command is the project's default and stays; 'missing' when not found. */
  deleteTestCommand(
    project: { id: string; key: string },
    id: string,
  ): Promise<'deleted' | 'default' | 'missing'> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('project_test_commands')
        .select('is_default')
        .where('project_id', '=', project.id)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (row === undefined) return 'missing' as const
      if (row.is_default) return 'default' as const
      const chosen = await trx
        .selectFrom('tasks')
        .select('id')
        .where('test_command_id', '=', id)
        .execute()
      await trx.deleteFrom('project_test_commands').where('id', '=', id).execute()
      await publishAll(trx, project.key, chosen)
      return 'deleted' as const
    })
  }
}

async function publishAll(
  trx: Transaction<Database>,
  key: string,
  tasks: { id: string }[],
): Promise<void> {
  await publish(trx, { topic: 'project.updated', key })
  for (const task of tasks) await publish(trx, { topic: 'task.updated', taskId: task.id })
}
