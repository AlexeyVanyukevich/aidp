import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { planToKeepFor } from './plan-history.queries.js'
import {
  readTitleSuggestion,
  type TitleSuggestion,
  type TitleRunFacts,
} from './title-suggestion.js'
import type {
  ApprovalKind,
  ApprovalStatus,
  Block,
  RunStatus,
  TaskState,
} from '../../shared/vocabulary.js'

export interface TaskView {
  id: string
  key: string
  number: number
  title: string
  description_md: string
  state: TaskState
  position: number
  budget_usd: number | null
  /** The project test command the owner chose; null follows the project's default. */
  test_command_id: string | null
  /** What the latest delivery run that started tests with; null when none has. */
  tested_with: string | null
  project: { key: string; name: string; github_repo: string }
  /** The question the card waits on: open, or expired and blocking it; a batch's count. */
  approval: { id: string; kind: ApprovalKind; status: ApprovalStatus; questions: number } | null
  /** Why a Blocked card is blocked; null in any other state. */
  block: Block | null
  /** Why the latest run, a draft, failed; null otherwise (slice 3 spec, §5). */
  draft_failure: string | null
  /** On a Failed card: the run whose accepted plan a Re-run can keep; null when there is none. */
  plan_to_keep: { run: number } | null
  /** The task's latest title run, read for the card; null when there is nothing to show. */
  title_suggestion: TitleSuggestion | null
  /** The task's latest rephrase run, with its suggestion while one is pending; null before any. */
  rephrase: RephraseView | null
}

export interface RephraseView {
  status: RunStatus
  /** Why the run failed; null while it did not. */
  failure_reason: string | null
  /** The pending suggestion; `stale` when the description has changed since it was written. */
  suggestion: { body_md: string; stale: boolean } | null
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

/** The task's latest title run, with the suggestion its artifact holds. */
export async function latestTitleRun(
  db: Kysely<Database>,
  taskId: string,
): Promise<(TitleRunFacts & { id: string; artifact_id: string | null }) | undefined> {
  const run = await db
    .selectFrom('runs')
    .select(['id', 'status', 'failure_reason'])
    .where('task_id', '=', taskId)
    .where('kind', '=', 'title')
    .orderBy('created_at', 'desc')
    .orderBy('number', 'desc')
    .executeTakeFirst()
  if (run === undefined) return undefined
  const artifact = await db
    .selectFrom('artifacts')
    .select(['id', 'data'])
    .where('run_id', '=', run.id)
    .where('kind', '=', 'title')
    .orderBy('created_at', 'desc')
    .executeTakeFirst()
  const data = artifact?.data as {
    title?: string
    reason?: string
    decision?: string | null
  } | null
  return {
    id: run.id,
    status: run.status,
    failure_reason: run.failure_reason,
    artifact_id: artifact?.id ?? null,
    suggestion:
      data === null || data === undefined || typeof data.title !== 'string'
        ? null
        : { title: data.title, reason: data.reason ?? '', decision: data.decision ?? null },
  }
}

/** The task's latest rephrase run, as the card shows it. */
async function latestRephrase(
  db: Kysely<Database>,
  taskId: string,
  description: string,
): Promise<RephraseView | null> {
  const run = await db
    .selectFrom('runs')
    .select(['status', 'failure_reason', 'base_md', 'suggestion_md', 'suggestion_status'])
    .where('task_id', '=', taskId)
    .where('kind', '=', 'rephrase')
    .orderBy('created_at', 'desc')
    .orderBy('number', 'desc')
    .executeTakeFirst()
  if (run === undefined) return null
  return {
    status: run.status,
    failure_reason: run.status === 'failed' ? run.failure_reason : null,
    suggestion:
      run.suggestion_status === 'pending' && run.suggestion_md !== null
        ? { body_md: run.suggestion_md, stale: run.base_md !== description }
        : null,
  }
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
        'tasks.test_command_id',
        'projects.key as project_key',
        'projects.name as project_name',
        'projects.github_repo',
      ])
      .where('tasks.id', '=', id)
      .executeTakeFirst()
    if (row === undefined) return undefined
    const run = await this.db
      .selectFrom('runs')
      .select(['id', 'kind', 'status', 'block', 'failure_reason'])
      .where('task_id', '=', id)
      .where('kind', 'in', ['spec', 'delivery'])
      .orderBy('created_at', 'desc')
      .executeTakeFirst()
    const tested = await this.db
      .selectFrom('runs')
      .select('test_command')
      .where('task_id', '=', id)
      .where('kind', '=', 'delivery')
      .where('started_at', 'is not', null)
      .orderBy('created_at', 'desc')
      .executeTakeFirst()
    const approval =
      run === undefined
        ? undefined
        : await this.db
            .selectFrom('approval_requests')
            .select(['id', 'kind', 'status', 'questions'])
            .where('run_id', '=', run.id)
            .where('status', 'in', ['open', 'expired'])
            .orderBy('created_at', 'desc')
            .executeTakeFirst()
    const title = await latestTitleRun(this.db, id)
    const kept = row.state === 'failed' ? await planToKeepFor(this.db, id) : undefined
    return {
      id: row.id,
      key: `${row.project_key}-${row.number}`,
      number: row.number,
      title: row.title,
      description_md: row.description_md,
      state: row.state,
      position: row.position,
      budget_usd: row.budget_usd === null ? null : Number(row.budget_usd),
      test_command_id: row.test_command_id,
      tested_with: tested?.test_command ?? null,
      project: { key: row.project_key, name: row.project_name, github_repo: row.github_repo },
      approval:
        approval === undefined
          ? null
          : {
              id: approval.id,
              kind: approval.kind,
              status: approval.status,
              questions: approval.kind === 'questions' ? (approval.questions ?? []).length : 1,
            },
      block: row.state === 'blocked' ? (run?.block ?? null) : null,
      draft_failure: run?.kind === 'spec' && run.status === 'failed' ? run.failure_reason : null,
      plan_to_keep: kept === undefined ? null : { run: kept.runNumber },
      title_suggestion: readTitleSuggestion(title),
      rephrase: await latestRephrase(this.db, id, row.description_md),
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
      test_command_id?: string | null
    },
  ): Promise<void> {
    await this.db
      .updateTable('tasks')
      .set({ ...fields, updated_at: new Date() })
      .where('id', '=', id)
      .execute()
  }

  /**
   * Locks and reads every task of the project, so a concurrent move waits for the renumbering.
   * The project row comes first: `insert` updates it, so a task being created is numbered too.
   */
  async lockForReorder(
    trx: Transaction<Database>,
    projectId: string,
  ): Promise<{ id: string; state: TaskState; position: number; number: number }[]> {
    await trx
      .selectFrom('projects')
      .select('id')
      .where('id', '=', projectId)
      .forNoKeyUpdate()
      .execute()
    return trx
      .selectFrom('tasks')
      .select(['id', 'state', 'position', 'number'])
      .where('project_id', '=', projectId)
      .orderBy('id')
      .forUpdate()
      .execute()
  }

  async setPosition(trx: Transaction<Database>, id: string, position: number): Promise<void> {
    await trx
      .updateTable('tasks')
      .set({ position, updated_at: new Date() })
      .where('id', '=', id)
      .execute()
  }
}
