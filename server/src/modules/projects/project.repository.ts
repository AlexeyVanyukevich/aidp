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
}

const COLUMNS = [
  'id',
  'key',
  'name',
  'repo_path',
  'github_repo',
  'base_branch',
  'test_command',
] as const

export class ProjectRepository {
  constructor(private readonly db: Kysely<Database>) {}

  list(): Promise<ProjectView[]> {
    return this.db.selectFrom('projects').select(COLUMNS).orderBy('key').execute()
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

  insert(input: Omit<ProjectView, 'id'>): Promise<ProjectView> {
    return this.db.insertInto('projects').values(input).returning(COLUMNS).executeTakeFirstOrThrow()
  }
}
