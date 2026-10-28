import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

export interface ProjectView {
  id: string
  key: string
  name: string
  repo_path: string
  github_repo: string
  base_branch: string
  test_command: string
  setup_command: string | null
}

export interface ProjectLinkView {
  key: string
  name: string
  note: string
}

export interface ProjectWithLinks extends ProjectView {
  links: ProjectLinkView[]
}

const COLUMNS = [
  'id',
  'key',
  'name',
  'repo_path',
  'github_repo',
  'base_branch',
  'test_command',
  'setup_command',
] as const

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
    return projects.map((project) => ({
      ...project,
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
    changes: { setup_command?: string | null; test_command?: string },
  ): Promise<ProjectView | undefined> {
    return this.db
      .updateTable('projects')
      .set(changes)
      .where('key', '=', key)
      .returning(COLUMNS)
      .executeTakeFirst()
  }

  insert(input: Omit<ProjectView, 'id'>): Promise<ProjectView> {
    return this.db.insertInto('projects').values(input).returning(COLUMNS).executeTakeFirstOrThrow()
  }
}
