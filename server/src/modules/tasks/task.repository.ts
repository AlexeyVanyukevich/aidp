import { sql, type Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { ApprovalKind, ApprovalStatus, Block, TaskState } from '../../shared/vocabulary.js'

export interface TaskView {
  id: string
  key: string
  number: number
  title: string
  description_md: string
  state: TaskState
  position: number
  budget_usd: number | null
  project: { key: string; name: string; github_repo: string }
  /** The question the card waits on: open, or expired and blocking it. */
  approval: { id: string; kind: ApprovalKind; status: ApprovalStatus } | null
  /** Why a Blocked card is blocked; null in any other state. */
  block: Block | null
}

export interface TaskCard {
  id: string
  key: string
  title: string
  state: TaskState
  position: number
  phase: string | null
  attempt: number | null
  models: string[]
  cost_usd: number
  cost_complete: boolean
  pr_url: string | null
  /** An open question, or an expired one, waits on this card. */
  question_waiting: boolean
}

export class TaskRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async get(id: string): Promise<TaskView | undefined> {
    const row = await this.db
      .selectFrom('tasks')
      .innerJoin('projects', 'projects.id', 'tasks.project_id')
      .select([
        'tasks.id',
        'tasks.number',
        'tasks.title',
        'tasks.description_md',
        'tasks.state',
        'tasks.position',
        'tasks.budget_usd',
        'projects.key as project_key',
        'projects.name as project_name',
        'projects.github_repo',
      ])
      .where('tasks.id', '=', id)
      .executeTakeFirst()
    if (row === undefined) return undefined
    const run = await this.db
      .selectFrom('runs')
      .select(['id', 'block'])
      .where('task_id', '=', id)
      .orderBy('created_at', 'desc')
      .executeTakeFirst()
    const approval =
      run === undefined
        ? undefined
        : await this.db
            .selectFrom('approval_requests')
            .select(['id', 'kind', 'status'])
            .where('run_id', '=', run.id)
            .where('status', 'in', ['open', 'expired'])
            .orderBy('created_at', 'desc')
            .executeTakeFirst()
    return {
      id: row.id,
      key: `${row.project_key}-${row.number}`,
      number: row.number,
      title: row.title,
      description_md: row.description_md,
      state: row.state,
      position: row.position,
      budget_usd: row.budget_usd === null ? null : Number(row.budget_usd),
      project: { key: row.project_key, name: row.project_name, github_repo: row.github_repo },
      approval: approval ?? null,
      block: row.state === 'blocked' ? (run?.block ?? null) : null,
    }
  }

  async board(projectId: string, projectKey: string): Promise<TaskCard[]> {
    const rows = await this.db
      .selectFrom('tasks')
      .select(['id', 'number', 'title', 'state', 'position'])
      .where('project_id', '=', projectId)
      .orderBy('state')
      .orderBy('position')
      .orderBy('number')
      .execute()
    const waiting = new Set(
      rows.length === 0
        ? []
        : (
            await this.db
              .selectFrom('approval_requests')
              .innerJoin('runs', 'runs.id', 'approval_requests.run_id')
              .select('runs.task_id')
              .where(
                'runs.task_id',
                'in',
                rows.map((row) => row.id),
              )
              .where('approval_requests.status', 'in', ['open', 'expired'])
              .execute()
          ).map((row) => row.task_id),
    )
    return rows.map((row) => ({
      id: row.id,
      key: `${projectKey}-${row.number}`,
      title: row.title,
      state: row.state,
      position: row.position,
      // Filled in by the service from the latest run and the task's events.
      phase: null,
      attempt: null,
      models: [],
      cost_usd: 0,
      cost_complete: true,
      pr_url: null,
      question_waiting: waiting.has(row.id),
    }))
  }

  /** Takes the next number from the project row, so two creates never share one. */
  async insert(
    projectId: string,
    input: { title: string; description_md?: string | undefined; budget_usd?: number | undefined },
  ): Promise<string> {
    return this.db.transaction().execute(async (trx) => {
      const { number } = await trx
        .updateTable('projects')
        .set((eb) => ({ next_task_number: eb('next_task_number', '+', 1) }))
        .where('id', '=', projectId)
        .returning(sql<number>`next_task_number - 1`.as('number'))
        .executeTakeFirstOrThrow()
      const { last } = await trx
        .selectFrom('tasks')
        .select(sql<number>`coalesce(max(position), 0)`.as('last'))
        .where('project_id', '=', projectId)
        .where('state', '=', 'backlog')
        .executeTakeFirstOrThrow()
      const row = await trx
        .insertInto('tasks')
        .values({
          project_id: projectId,
          number,
          title: input.title,
          description_md: input.description_md ?? '',
          state: 'backlog',
          position: last + 1,
          budget_usd: input.budget_usd ?? null,
          updated_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return row.id
    })
  }

  async update(
    id: string,
    fields: {
      title?: string
      description_md?: string
      budget_usd?: number | null
      position?: number
    },
  ): Promise<void> {
    await this.db
      .updateTable('tasks')
      .set({ ...fields, updated_at: new Date() })
      .where('id', '=', id)
      .execute()
  }
}
