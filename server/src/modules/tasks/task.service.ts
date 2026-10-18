import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { NotFoundError } from '../../shared/errors.js'
import type { ProjectRepository, ProjectView } from '../projects/project.repository.js'
import { moveTask } from './task.moves.js'
import type { TaskCard, TaskRepository, TaskView } from './task.repository.js'

export class TaskService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly tasks: TaskRepository,
    private readonly projects: ProjectRepository,
  ) {}

  private async project(key: string): Promise<ProjectView> {
    const project = await this.projects.byKey(key)
    if (project === undefined) throw new NotFoundError('No such project')
    return project
  }

  async get(id: string): Promise<TaskView> {
    const task = await this.tasks.get(id)
    if (task === undefined) throw new NotFoundError('No such task')
    return task
  }

  async board(key: string): Promise<{ project: ProjectView; tasks: TaskCard[] }> {
    const project = await this.project(key)
    return { project, tasks: await this.tasks.board(project.id, project.key) }
  }

  async create(
    key: string,
    input: { title: string; description_md?: string; budget_usd?: number },
  ): Promise<TaskView> {
    const project = await this.project(key)
    const id = await this.tasks.insert(project.id, input)
    await publish(this.db, { topic: 'task.updated', taskId: id })
    return this.get(id)
  }

  async patch(
    id: string,
    input: {
      title?: string
      description_md?: string
      budget_usd?: number | null
      position?: number
      state?: 'done'
    },
  ): Promise<TaskView> {
    await this.get(id)
    const { state, ...fields } = input
    if (state === 'done') await moveTask(this.db, id, 'drag_done')
    if (Object.keys(fields).length > 0) {
      await this.tasks.update(id, fields)
      await publish(this.db, { topic: 'task.updated', taskId: id })
    }
    return this.get(id)
  }
}
