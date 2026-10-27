import { NotFoundError, ValidationError } from '../../shared/errors.js'
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
  async create(
    body: Omit<ProjectView, 'id' | 'setup_command'> & { setup_command?: string | null },
  ): Promise<ProjectView> {
    const input = { ...body, setup_command: blankToNull(body.setup_command) }
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
    if (input.setup_command !== null)
      await this.checkSetupCommand(input.setup_command, input.repo_path)
    return this.repository.insert(input)
  }

  /** Sets the setup command, or clears it with null or a blank value. */
  async updateSetupCommand(key: string, value: string | null): Promise<ProjectView> {
    const project = await this.repository.byKey(key)
    if (project === undefined) throw new NotFoundError(`No project ${key}`)
    const setupCommand = blankToNull(value)
    if (setupCommand !== null) await this.checkSetupCommand(setupCommand, project.repo_path)
    const updated = await this.repository.updateSetupCommand(key, setupCommand)
    if (updated === undefined) throw new NotFoundError(`No project ${key}`)
    return updated
  }

  private async checkSetupCommand(command: string, repoPath: string): Promise<void> {
    if (!(await this.inspector.commandExists(command, repoPath))) {
      throw new ValidationError('The setup command does not resolve in that repository', {
        field: 'setup_command',
      })
    }
  }
}

function blankToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === '' ? null : value
}
