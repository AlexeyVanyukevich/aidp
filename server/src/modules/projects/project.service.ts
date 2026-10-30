import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js'
import {
  isTakenName,
  type ProjectRepository,
  type ProjectView,
  type ProjectWithLinks,
  type TestCommandView,
} from './project.repository.js'
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
    if (input.setup_command !== null)
      await this.checkSetupCommand(input.setup_command, input.repo_path)
    // `npm test` is not checked: the repository may not have been set up yet.
    return this.repository.insert(input, 'npm test')
  }

  /** Sets the setup command, cleared by null or a blank value. */
  async update(
    key: string,
    body: { setup_command?: string | null | undefined },
  ): Promise<ProjectView> {
    const project = await this.repository.byKey(key)
    if (project === undefined) throw new NotFoundError(`No project ${key}`)
    const changes: { setup_command?: string | null } = {}
    if (body.setup_command !== undefined) {
      const setupCommand = blankToNull(body.setup_command)
      if (setupCommand !== null) await this.checkSetupCommand(setupCommand, project.repo_path)
      changes.setup_command = setupCommand
    }
    const updated = await this.repository.update(key, changes)
    if (updated === undefined) throw new NotFoundError(`No project ${key}`)
    return updated
  }

  async testCommands(key: string): Promise<TestCommandView[]> {
    return this.repository.testCommands((await this.project(key)).id)
  }

  async addTestCommand(
    key: string,
    body: { name: string; command: string },
  ): Promise<TestCommandView> {
    const project = await this.project(key)
    const name = await this.checkName(project.id, body.name)
    await this.checkCommand(project, body.command)
    try {
      return await this.repository.addTestCommand(project, name, body.command)
    } catch (error) {
      throw this.nameRace(error)
    }
  }

  /** All or none: every field present is checked before any is written. */
  async updateTestCommand(
    key: string,
    id: string,
    body: {
      name?: string | undefined
      command?: string | undefined
      is_default?: true | undefined
    },
  ): Promise<TestCommandView> {
    const project = await this.project(key)
    if ((await this.repository.testCommand(project.id, id)) === undefined) {
      throw new NotFoundError('No such test command')
    }
    const changes: { name?: string; command?: string; is_default?: true } = {}
    if (body.name !== undefined) changes.name = await this.checkName(project.id, body.name, id)
    if (body.command !== undefined) {
      await this.checkCommand(project, body.command)
      changes.command = body.command
    }
    if (body.is_default === true) changes.is_default = true
    try {
      const updated = await this.repository.updateTestCommand(project, id, changes)
      if (updated === undefined) throw new NotFoundError('No such test command')
      return updated
    } catch (error) {
      throw this.nameRace(error)
    }
  }

  async removeTestCommand(key: string, id: string): Promise<void> {
    const project = await this.project(key)
    const outcome = await this.repository.deleteTestCommand(project, id)
    if (outcome === 'missing') throw new NotFoundError('No such test command')
    if (outcome === 'default') {
      throw new ConflictError(
        'The default test command cannot be removed; make another the default',
      )
    }
  }

  private async project(key: string): Promise<ProjectView> {
    const project = await this.repository.byKey(key)
    if (project === undefined) throw new NotFoundError(`No project ${key}`)
    return project
  }

  private async checkName(projectId: string, raw: string, exceptId?: string): Promise<string> {
    const name = raw.trim()
    if (name === '' || name.length > 40) {
      throw new ValidationError('The name must be 1 to 40 characters', { field: 'name' })
    }
    if (await this.repository.nameTaken(projectId, name, exceptId)) {
      throw new ValidationError('Another test command of this project has that name', {
        field: 'name',
      })
    }
    return name
  }

  private async checkCommand(project: ProjectView, command: string): Promise<void> {
    if (command.trim() === '' || command.length > 500) {
      throw new ValidationError('The command must be 1 to 500 characters, not blank', {
        field: 'command',
      })
    }
    if (!(await this.inspector.commandExists(command, project.repo_path))) {
      throw new ValidationError('The test command does not resolve in that repository', {
        field: 'command',
      })
    }
  }

  /** Two requests can pass the name check together; the index decides, and it is a 400. */
  private nameRace(error: unknown): unknown {
    return isTakenName(error)
      ? new ValidationError('Another test command of this project has that name', {
          field: 'name',
        })
      : error
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
