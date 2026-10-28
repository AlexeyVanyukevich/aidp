import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { ConflictError, NotFoundError } from '../../shared/errors.js'
import type { TaskState } from '../../shared/vocabulary.js'
import type { CostService } from '../costs/cost.service.js'
import type { ProjectRepository, ProjectView } from '../projects/project.repository.js'
import type { RunRepository } from '../runs/run.repository.js'
import { moveTask } from './task.moves.js'
import type { TaskCard, TaskRepository, TaskView } from './task.repository.js'

/** Where the description may change: before a draft, and between drafts (slice 3 spec, §8). */
const DESCRIBABLE: readonly TaskState[] = ['backlog', 'spec_review']

export class TaskService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly tasks: TaskRepository,
    private readonly projects: ProjectRepository,
    private readonly runs: RunRepository,
    private readonly costs: CostService,
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
    const cards = await this.tasks.board(project.id, project.key)
    const ids = cards.map((card) => card.id)
    const [latest, totals] = await Promise.all([
      this.runs.latestByTask(ids),
      this.costs.totals(ids),
    ])
    return {
      project,
      tasks: cards.map((card) => {
        const run = latest.get(card.id)
        const cost = totals.get(card.id)
        return {
          ...card,
          phase: run?.phase ?? null,
          attempt: run?.attempt ?? null,
          pr_url: run?.pr_url ?? null,
          models: cost?.models ?? [],
          cost_usd: cost?.usd ?? 0,
          cost_complete: cost?.complete ?? true,
        }
      }),
    }
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
    const task = await this.get(id)
    const { state, ...fields } = input
    // A draft reads the description it started with; later runs read the approved spec.
    if (fields.description_md !== undefined && !DESCRIBABLE.includes(task.state))
      throw new ConflictError(`The description is fixed in ${task.state}`, { state: task.state })
    // Review is the owner's drag; any other state asks for `mark_done`, which refuses what it must.
    if (state === 'done')
      await moveTask(this.db, id, task.state === 'review' ? 'drag_done' : 'mark_done')
    if (Object.keys(fields).length > 0) {
      await this.tasks.update(id, fields)
      await publish(this.db, { topic: 'task.updated', taskId: id })
    }
    return this.get(id)
  }
}
