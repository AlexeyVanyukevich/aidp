import { ValidationError } from '../../shared/errors.js'
import type { ProjectRepository, ProjectView } from './project.repository.js'
import { matchesGithubRepo, type RepoInspector } from './repo-inspector.js'

export class ProjectService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly inspector: RepoInspector,
  ) {}

  list(): Promise<ProjectView[]> {
    return this.repository.list()
  }

  /**
   * Checked here rather than on the first run: a wrong path or a test command that does not
   * exist would otherwise surface as a failed run, after tokens were spent finding out.
   */
  async create(input: Omit<ProjectView, 'id'>): Promise<ProjectView> {
    const taken = await this.repository.exists(input.key, input.repo_path)
    if (taken !== undefined) {
      throw new ValidationError(`A project already uses this ${taken.replace('_', ' ')}`, {
        field: taken,
      })
    }
    const repo = await this.inspector.inspect(input.repo_path)
    if (!repo.isGitRepo) {
      throw new ValidationError('repo_path is not a git repository', { field: 'repo_path' })
    }
    if (!matchesGithubRepo(repo.remotes, input.github_repo)) {
      throw new ValidationError('No remote of that repository points at github_repo', {
        field: 'github_repo',
        remotes: repo.remotes,
      })
    }
    if (!(await this.inspector.commandExists(input.test_command, input.repo_path))) {
      throw new ValidationError('The test command does not resolve in that repository', {
        field: 'test_command',
      })
    }
    return this.repository.insert(input)
  }
}
