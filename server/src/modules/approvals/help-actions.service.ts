import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { AppError, ConflictError, NotFoundError } from '../../shared/errors.js'
import { publish } from '../../shared/bus.js'
import type { HelpResult, HelpSubject } from '../../shared/vocabulary.js'
import { sameTitle } from '../proposals/proposal.rules.js'
import type { Gh } from '../runs/pr-poller.js'
import { planToKeepFor } from '../tasks/plan-history.queries.js'
import { rerunCard } from '../tasks/task.actions.js'
import { moveTask } from '../tasks/task.moves.js'
import { TaskRepository } from '../tasks/task.repository.js'
import { stands, type CardDecision } from './decision-rules.js'
import { readSubjectFacts } from './help.service.js'

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

/** `gh` ran and failed: its reason travels in `details`, never in the message. */
export class GhFailedError extends AppError {
  readonly statusCode = 502
  readonly code = 'gh_failed'
}

/** What the owner's presses on a review's result do: file a finding, merge, close and re-run. */
export class HelpActionsService {
  private readonly tasks: TaskRepository

  constructor(
    private readonly db: Kysely<Database>,
    private readonly gh: Gh,
    private readonly clock: () => Date,
  ) {
    this.tasks = new TaskRepository(db)
  }

  private async runGh(args: string[]): Promise<void> {
    const out = await this.gh(args)
    if (out.code !== 0)
      throw new GhFailedError('gh failed', {
        stderr: out.stderr.trim(),
        command: args.slice(0, 2).join(' '),
      })
  }

  /**
   * The pull request review a press acts on: the card is in Review, the help is the newest
   * succeeded one and still stands, and the pull request it read has a number.
   */
  private async pullRequestReview(taskId: string, helpId: string) {
    const task = await this.db
      .selectFrom('tasks')
      .innerJoin('projects', 'projects.id', 'tasks.project_id')
      .select(['tasks.state', 'projects.github_repo'])
      .where('tasks.id', '=', taskId)
      .executeTakeFirst()
    if (task === undefined) throw new NotFoundError('No such task')
    const refuse = (message: string): never => {
      throw new ConflictError(message, { reason: 'not_offered', state: task.state })
    }
    if (task.state !== 'review') refuse('The card is not in Review')
    const newest = await this.db
      .selectFrom('helps')
      .innerJoin('runs', 'runs.id', 'helps.run_id')
      .select([
        'helps.id',
        'helps.subject',
        'helps.result',
        'helps.retired_at',
        'helps.decision',
        'helps.mode',
      ])
      .where('runs.task_id', '=', taskId)
      .where('helps.decision', '=', 'pull_request')
      .where('helps.mode', '=', 'code_review')
      .where('helps.status', '=', 'succeeded')
      .orderBy('helps.created_at', 'desc')
      .limit(1)
      .executeTakeFirst()
    if (newest === undefined || newest.id !== helpId || newest.retired_at !== null)
      return refuse('This is not the review that stands')
    const subject = newest.subject as HelpSubject
    const facts = await readSubjectFacts(this.db, taskId)
    if (!stands('pull_request' as CardDecision, subject, facts))
      return refuse('This is not the review that stands')
    const result = newest.result as Extract<HelpResult, { mode: 'code_review' }> | null
    if (result === null || result.mode !== 'code_review') return refuse('This is not a review')
    const prRunId = (subject as { pr_run_id: string }).pr_run_id
    const run = await this.db
      .selectFrom('runs')
      .select('pr_number')
      .where('id', '=', prRunId)
      .executeTakeFirst()
    if (run?.pr_number === null || run === undefined) return refuse('The run has no pull request')
    return { result, prRunId, prNumber: run.pr_number, repo: task.github_repo, help: newest }
  }

  /** Moves the card from Review to Done; a card the poller already moved for the run counts. */
  private async moveToDone(taskId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const task = await trx
        .selectFrom('tasks')
        .select('state')
        .where('id', '=', taskId)
        .forUpdate()
        .executeTakeFirstOrThrow()
      if (task.state === 'done') return
      await moveTask(trx, taskId, 'merge')
    })
  }

  private async runMerge(
    taskId: string,
    review: Awaited<ReturnType<HelpActionsService['pullRequestReview']>>,
  ): Promise<void> {
    await this.runGh([
      'pr',
      'merge',
      String(review.prNumber),
      '--repo',
      review.repo,
      '--rebase',
      '--delete-branch',
      '--match-head-commit',
      review.result.commit as string,
    ])
    await this.moveToDone(taskId)
  }

  /** Merge, for a result whose step is `merge`. */
  async merge(taskId: string, helpId: string): Promise<{ state: 'done' }> {
    const review = await this.pullRequestReview(taskId, helpId)
    if (review.result.next_step !== 'merge' || review.result.commit === null)
      throw new ConflictError('This review does not offer a merge', { reason: 'not_offered' })
    await this.runMerge(taskId, review)
    return { state: 'done' }
  }

  /** Files every outside finding not on the board, in one transaction, then merges. */
  async mergeAndFile(taskId: string, helpId: string): Promise<{ filed: string[] }> {
    const review = await this.pullRequestReview(taskId, helpId)
    if (review.result.next_step !== 'merge_and_file' || review.result.commit === null)
      throw new ConflictError('This review does not offer a merge', { reason: 'not_offered' })
    const filed = await this.db.transaction().execute(async (trx) => {
      const head = await taskHead(trx, taskId)
      const line = provenanceLine(review.help as never, head.taskKey)
      const found = outsideOf(review.result)
      const unfiled: typeof found = []
      for (const item of found)
        if (
          (await findOnBoard(trx, item.finding.project ?? head.ownKey, item.finding.title)) === null
        )
          unfiled.push(item)
      const keys: string[] = []
      for (const item of unfiled) {
        const made = await fileOutside(trx, this.tasks, {
          ownProjectId: head.projectId,
          ownKey: head.ownKey,
          line,
          finding: item.finding,
        })
        keys.push(made.key)
      }
      return keys
    })
    await this.runMerge(taskId, review)
    return { filed }
  }

  /** Closes the pull request, then moves the card through Failed to Ready with the note. */
  async closeAndRerun(taskId: string, helpId: string, note: string): Promise<{ state: 'ready' }> {
    const review = await this.pullRequestReview(taskId, helpId)
    const step = review.result.next_step
    if (step !== 'rerun_keep' && step !== 'rerun_again')
      throw new ConflictError('This review does not offer a re-run', { reason: 'not_offered' })
    if (step === 'rerun_keep' && (await planToKeepFor(this.db, taskId)) === undefined)
      throw new ConflictError('This task has no accepted plan to keep', { reason: 'no_plan' })
    await this.runGh(['pr', 'close', String(review.prNumber), '--repo', review.repo])
    const now = this.clock()
    await this.db.transaction().execute(async (trx) => {
      const task = await trx
        .selectFrom('tasks')
        .select('state')
        .where('id', '=', taskId)
        .forUpdate()
        .executeTakeFirstOrThrow()
      // The poller may have moved the card to Failed for this run since gh closed the pull request.
      if (task.state === 'review') {
        await moveTask(trx, taskId, 'close_pr')
        await trx
          .updateTable('runs')
          .set({ failure_reason: 'pull request closed without merging' })
          .where('id', '=', review.prRunId)
          .execute()
      }
      await rerunCard(trx, taskId, step === 'rerun_keep' ? 'keep' : 'again', note, now)
    })
    return { state: 'ready' }
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
