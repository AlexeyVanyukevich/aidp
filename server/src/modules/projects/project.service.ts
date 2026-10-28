import { NotFoundError, ValidationError } from '../../shared/errors.js'
import type { ProjectRepository, ProjectView, ProjectWithLinks } from './project.repository.js'
import { matchesGithubRepo, type RepoInspector } from './repo-inspector.js'

export class ProjectService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly inspector: RepoInspector,
  ) {}

  list(): Promise<ProjectWithLinks[]> {
    return this.repository.listWithLinks()
  }

  async addLink(key: string, target: string, note: string): Promise<void> {
    const project = await this.repository.byKey(key)
    if (project === undefined) throw new NotFoundError(`No project ${key}`)
    // The note is checked here, not in the schema, so the refusal names its field.
    if (note.trim() === '' || note.length > 500) {
      throw new ValidationError('The note must be 1 to 500 characters, not blank', {
        field: 'note',
      })
    }
    if (target === key) {
      throw new ValidationError('A project cannot link to itself', { field: 'target' })
    }
    const linked = await this.repository.byKey(target)
    if (linked === undefined) {
      throw new ValidationError(`No project ${target}`, { field: 'target' })
    }
    if (!(await this.repository.addLink(project.id, linked.id, note))) {
      throw new ValidationError(`${key} already links to ${target}`, { field: 'target' })
    }
  }

  async removeLink(key: string, target: string): Promise<void> {
    const project = await this.repository.byKey(key)
    const linked = await this.repository.byKey(target)
    if (project === undefined || linked === undefined) throw new NotFoundError('No such link')
    if (!(await this.repository.removeLink(project.id, linked.id))) {
      throw new NotFoundError('No such link')
    }
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

  /**
   * Sets the fields present: the setup command (cleared by null or a blank value) and the test
   * command. Both are checked before either is written, the test command first.
   */
  async update(
    key: string,
    body: { setup_command?: string | null | undefined; test_command?: string | undefined },
  ): Promise<ProjectView> {
    const project = await this.repository.byKey(key)
    if (project === undefined) throw new NotFoundError(`No project ${key}`)
    const changes: { setup_command?: string | null; test_command?: string } = {}
    if (body.test_command !== undefined) {
      if (!(await this.inspector.commandExists(body.test_command, project.repo_path))) {
        throw new ValidationError('The test command does not resolve in that repository', {
          field: 'test_command',
        })
      }
      changes.test_command = body.test_command
    }
    if (body.setup_command !== undefined) {
      const setupCommand = blankToNull(body.setup_command)
      if (setupCommand !== null) await this.checkSetupCommand(setupCommand, project.repo_path)
      changes.setup_command = setupCommand
    }
    const updated = await this.repository.update(key, changes)
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
