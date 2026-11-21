import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { ConflictError } from '../../shared/errors.js'
import { publish } from '../../shared/bus.js'
import type { HelpResult } from '../../shared/vocabulary.js'
import { sameTitle } from '../proposals/proposal.rules.js'
import { TaskRepository } from '../tasks/task.repository.js'

/** An outside finding of a stored review result. */
export interface OutsideFinding {
  title: string
  text: string
  project?: string
}

type Db = Kysely<Database> | Transaction<Database>

/** The outside findings of a result, with their index in its findings. */
export function outsideOf(result: HelpResult | null): { index: number; finding: OutsideFinding }[] {
  if (result === null || !('findings' in result)) return []
  return result.findings.flatMap((item, index) =>
    item.destination === 'outside' && item.title !== undefined
      ? [
          {
            index,
            finding: {
              title: item.title,
              text: item.text,
              ...(item.project === undefined ? {} : { project: item.project }),
            },
          },
        ]
      : [],
  )
}

/** The task in the project whose title matches, as `{ key, state }`, or null. */
export async function findOnBoard(
  db: Db,
  projectKey: string,
  title: string,
): Promise<{ key: string; state: string } | null> {
  const rows = await db
    .selectFrom('tasks')
    .innerJoin('projects', 'projects.id', 'tasks.project_id')
    .select(['tasks.number', 'tasks.state', 'tasks.title', 'projects.key'])
    .where('projects.key', '=', projectKey)
    .where((eb) =>
      eb(eb.fn('lower', [eb.fn('btrim', ['tasks.title'])]), '=', title.trim().toLowerCase()),
    )
    .orderBy('tasks.number')
    .execute()
  const same = rows.find((row) => sameTitle(row.title, title))
  return same === undefined ? null : { key: `${same.key}-${same.number}`, state: same.state }
}

/** Gives each outside finding of the results its `on_board`, looked up in its target project. */
export async function withOnBoard<T extends { result: HelpResult | null }>(
  db: Db,
  ownKey: string,
  helps: T[],
): Promise<T[]> {
  const out: T[] = []
  for (const help of helps) {
    const result = help.result
    if (result === null || !('findings' in result) || outsideOf(result).length === 0) {
      out.push(help)
      continue
    }
    const findings = [...result.findings]
    for (const { index, finding } of outsideOf(result)) {
      const found = await findOnBoard(db, finding.project ?? ownKey, finding.title)
      findings[index] = { ...findings[index]!, on_board: found }
    }
    out.push({ ...help, result: { ...result, findings } as HelpResult })
  }
  return out
}

/** The one line a filed task's description ends with: the review, the task and the owner. */
export function provenanceLine(
  help: { decision: string; mode: string; subject: unknown; result: HelpResult | null },
  taskKey: string,
): string {
  const result = help.result
  let review: string
  if (help.mode === 'review_plan') review = 'Plan review'
  else if (help.mode === 'code_review') {
    const commit = result !== null && 'commit' in result ? result.commit : null
    review = `Pull request review at commit ${commit === null ? 'unknown' : commit.slice(0, 7)}`
  } else {
    const version = (help.subject as { spec_version?: number } | null)?.spec_version
    review = `Spec review of v${version ?? '?'}`
  }
  return `${review} of ${taskKey}; filed by the owner.`
}

/**
 * Files one outside finding as a Backlog task in its target project, in the transaction given.
 * A task there with the same title is a conflict naming its key and state.
 */
export async function fileOutside(
  trx: Transaction<Database>,
  tasks: TaskRepository,
  input: { ownProjectId: string; ownKey: string; line: string; finding: OutsideFinding },
): Promise<{ key: string; state: 'backlog'; title: string }> {
  const { finding } = input
  const targetKey = finding.project ?? input.ownKey
  const target = await trx
    .selectFrom('projects')
    .select(['id', 'key'])
    .where('key', '=', targetKey)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow()
  const same = await findOnBoard(trx, targetKey, finding.title)
  if (same !== null)
    throw new ConflictError(`${same.key} (${same.state}) already has this title`, {
      reason: 'duplicate',
      key: same.key,
      state: same.state,
    })
  const id = await tasks.insert(
    target.id,
    {
      title: finding.title.trim(),
      description_md: `${finding.text.trimEnd()}\n\n${input.line}`,
    },
    trx,
  )
  const row = await trx
    .selectFrom('tasks')
    .select('number')
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  await publish(trx, { topic: 'task.updated', taskId: id })
  return { key: `${target.key}-${row.number}`, state: 'backlog', title: finding.title.trim() }
}

/** The task's key and project, for a provenance line and a target lookup. */
async function taskHead(db: Db, taskId: string) {
  const row = await db
    .selectFrom('tasks')
    .innerJoin('projects', 'projects.id', 'tasks.project_id')
    .select(['tasks.number', 'projects.id as projectId', 'projects.key'])
    .where('tasks.id', '=', taskId)
    .executeTakeFirstOrThrow()
  return { projectId: row.projectId, ownKey: row.key, taskKey: `${row.key}-${row.number}` }
}

/** What the owner's presses on a review's result do: file an outside finding. */
export class HelpActionsService {
  private readonly tasks: TaskRepository

  constructor(private readonly db: Kysely<Database>) {
    this.tasks = new TaskRepository(db)
  }

  /** A succeeded review help of the task, or a 409. */
  private async reviewOf(trx: Db, taskId: string, helpId: string) {
    const help = await trx
      .selectFrom('helps')
      .innerJoin('runs', 'runs.id', 'helps.run_id')
      .select([
        'helps.id',
        'helps.decision',
        'helps.mode',
        'helps.subject',
        'helps.result',
        'helps.status',
      ])
      .where('helps.id', '=', helpId)
      .where('runs.task_id', '=', taskId)
      .executeTakeFirst()
    const result = (help?.result ?? null) as HelpResult | null
    if (
      help === undefined ||
      help.status !== 'succeeded' ||
      result === null ||
      !('findings' in result)
    )
      throw new ConflictError('This is not a succeeded review of the task', {
        reason: 'not_offered',
      })
    return { ...help, result }
  }

  /** Files the outside finding at `index` as a Backlog task in its target project. */
  async file(taskId: string, helpId: string, index: number) {
    return this.db.transaction().execute(async (trx) => {
      const help = await this.reviewOf(trx, taskId, helpId)
      const finding = outsideOf(help.result).find((item) => item.index === index)
      if (finding === undefined)
        throw new ConflictError('That finding is not an outside finding', { reason: 'not_offered' })
      const head = await taskHead(trx, taskId)
      return fileOutside(trx, this.tasks, {
        ownProjectId: head.projectId,
        ownKey: head.ownKey,
        line: provenanceLine(help as never, head.taskKey),
        finding: finding.finding,
      })
    })
  }
}
