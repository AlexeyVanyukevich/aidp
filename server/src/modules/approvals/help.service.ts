import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { planToKeepFor } from '../tasks/plan-history.queries.js'
import { openProposalIds, proposalsOf } from '../proposals/proposal.repository.js'
import type { Bus } from '../../shared/bus.js'
import { publish } from '../../shared/bus.js'
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js'
import { newToken } from '../../shared/tokens.js'
import type {
  ApprovalKind,
  Block,
  HelpDecision,
  HelpMode,
  HelpResult,
  HelpStatus,
  HelpSubject,
  QuestionHelpMode,
} from '../../shared/vocabulary.js'
import type { ApprovalOption, BatchQuestion } from './approval-rules.js'
import {
  DECISION_MODES,
  offered,
  recommendableActions,
  specRead,
  stands,
  subjectOf,
  type CardDecision,
  type SubjectFacts,
} from './decision-rules.js'
import {
  checkDecisionResult,
  checkHelpResult,
  decisionResultOf,
  HELP_LIMITS,
  hasInFlight,
  isCurrent,
  questionOf,
  resultOf,
  type DecisionResultInput,
  type DecisionResultMode,
  type HelpResultInput,
} from './help-rules.js'

type Db = Kysely<Database> | Transaction<Database>

export interface HelpView {
  id: string
  approval_id: string | null
  decision: HelpDecision
  subject: HelpSubject | null
  question_index: number | null
  mode: HelpMode
  status: HelpStatus
  result: HelpResult | null
  reason: string | null
  created_at: Date
}

/** Where a decision help reads from (R8). */
export type CheckoutSource =
  | { source: 'base' }
  | { source: 'pr_branch'; branch: string }
  | { source: 'pull_request'; branch: string }
  | { source: 'paused_run'; run_id: string }

/** What a decision help carries beyond a question help: the project, the links and the source. */
export interface DecisionWork {
  repo_path: string
  base_branch: string
  links: {
    key: string
    name: string
    note: string
    repo_path: string
    github_repo: string
    base_branch: string
  }[]
  checkout: CheckoutSource
}

/** What a claim hands the runner: one help to carry beside its run. */
export interface HelpWork {
  id: string
  mode: HelpMode
  decision: HelpDecision
  subject: HelpSubject | null
  approval_id: string | null
  question_index: number | null
  /** What a decision help works in; null for a question help. */
  decision_work: DecisionWork | null
  /** Server-chosen, so the sweeper can close the phase of a help whose process is lost. */
  phase_id: string
  /** Counts the run's helps, the first being 1. */
  attempt: number
  run: {
    id: string
    number: number
    worktree_path: string | null
    task: { id: string; key: string; title: string; budget_usd: number | null }
  }
}

/** The facts the decision rules read for one task, as the database holds them now. */
export async function readSubjectFacts(db: Db, taskId: string): Promise<SubjectFacts> {
  const task = await db
    .selectFrom('tasks')
    .select('state')
    .where('id', '=', taskId)
    .executeTakeFirstOrThrow()
  const run = await db
    .selectFrom('runs')
    .select(['id', 'block', 'checkpoint'])
    .where('task_id', '=', taskId)
    .where('kind', 'in', ['spec', 'delivery'])
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  const delivery = await db
    .selectFrom('runs')
    .select(['id', 'pr_number'])
    .where('task_id', '=', taskId)
    .where('kind', '=', 'delivery')
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  const specs = await db
    .selectFrom('specs')
    .select(['version', 'status'])
    .where('task_id', '=', taskId)
    .execute()
  const latest = specs.reduce<number | null>(
    (best, spec) => (best === null || spec.version > best ? spec.version : best),
    null,
  )
  const approved = specs
    .filter((spec) => spec.status === 'approved')
    .reduce<number | null>(
      (best, spec) => (best === null || spec.version > best ? spec.version : best),
      null,
    )
  const approval = await db
    .selectFrom('approval_requests')
    .innerJoin('runs', 'runs.id', 'approval_requests.run_id')
    .select('approval_requests.status')
    .where('runs.task_id', '=', taskId)
    .where('approval_requests.status', 'in', ['open', 'expired'])
    // A proposal's request is settled on the Proposals tab; it is no question to help with.
    .where('approval_requests.kind', '!=', 'proposal')
    .orderBy('approval_requests.created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  const openProposals = await openProposalIds(db, taskId)
  const block = (run?.block ?? null) as Block | null
  const kept =
    task.state === 'failed' ? await planToKeepFor(db as Kysely<Database>, taskId) : undefined
  return {
    taskState: task.state,
    blockCause: block?.cause ?? null,
    planToKeep: kept !== undefined,
    checkpoint: run?.checkpoint !== null && run?.checkpoint !== undefined,
    approvalCurrent:
      approval !== undefined &&
      isCurrent({
        status: approval.status,
        taskState: task.state,
        blockCause: block?.cause ?? null,
      }),
    openProposals,
    hasPullRequest: delivery?.pr_number !== null && delivery?.pr_number !== undefined,
    latestSpecVersion: latest,
    approvedSpecVersion: approved,
    latestRunId: run?.id ?? null,
    latestDeliveryRunId: delivery?.id ?? null,
    runBlock: block?.cause ?? null,
  }
}

/**
 * Called in the transaction of every task move and every insert of a spec version, with the
 * task row locked: a queued or running decision help whose subject no longer stands is stopped
 * and its run cancelled; a succeeded one is retired.
 */
export async function settleHelps(
  db: Transaction<Database>,
  taskId: string,
  now: Date,
): Promise<void> {
  const helps = await db
    .selectFrom('helps')
    .innerJoin('runs', 'runs.id', 'helps.run_id')
    .select(['helps.id', 'helps.run_id', 'helps.decision', 'helps.subject', 'helps.status'])
    .where('runs.task_id', '=', taskId)
    .where('helps.decision', '!=', 'question')
    .where('helps.status', 'in', ['queued', 'running', 'succeeded'])
    .where('helps.retired_at', 'is', null)
    .execute()
  if (helps.length === 0) return
  const facts = await readSubjectFacts(db, taskId)
  let changed = false
  for (const help of helps) {
    if (stands(help.decision as CardDecision, help.subject as HelpSubject, facts)) continue
    changed = true
    if (help.status === 'succeeded') {
      await db.updateTable('helps').set({ retired_at: now }).where('id', '=', help.id).execute()
      continue
    }
    const stopped = await db
      .updateTable('helps')
      .set({ status: 'stopped', ended_at: now })
      .where('id', '=', help.id)
      .where('status', 'in', ['queued', 'running'])
      .returning('id')
      .executeTakeFirst()
    if (stopped === undefined) {
      // It saved its result while this ran: it is retired like any succeeded help.
      await db.updateTable('helps').set({ retired_at: now }).where('id', '=', help.id).execute()
      continue
    }
    await db
      .updateTable('runs')
      .set({ status: 'cancelled', ended_at: now, queued_at: null })
      .where('id', '=', help.run_id)
      .where('status', 'in', ['queued', 'running'])
      .execute()
  }
  if (changed) await publish(db, { topic: 'help.updated', taskId })
}

const COLUMNS = [
  'helps.id',
  'helps.approval_id',
  'helps.decision',
  'helps.subject',
  'helps.question_index',
  'helps.mode',
  'helps.status',
  'helps.result',
  'helps.reason',
  'helps.created_at',
] as const

/**
 * Ends a decision help's own run in the transaction that ends the help. A question help's run
 * is its asking run and is left alone: only a run of kind `help` is touched.
 */
export async function endHelpRun(
  trx: Transaction<Database>,
  runId: string,
  status: 'succeeded' | 'failed' | 'cancelled',
  reason: string | null,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('runs')
    .set({
      status,
      ended_at: now,
      queued_at: null,
      ...(status === 'failed' ? { failure_reason: reason } : {}),
    })
    .where('id', '=', runId)
    .where('kind', '=', 'help')
    .where('status', 'in', ['queued', 'running'])
    .execute()
}

/** The commit the helper read: the payload of the help run's `help_checkout` event, or none. */
async function checkoutCommit(trx: Transaction<Database>, runId: string): Promise<string | null> {
  const event = await trx
    .selectFrom('events')
    .select('payload')
    .where('run_id', '=', runId)
    .where('tool', '=', 'help_checkout')
    .orderBy('ts', 'desc')
    .limit(1)
    .executeTakeFirst()
  const commit = event?.payload.commit
  return typeof commit === 'string' ? commit : null
}

const TOKEN_LIFETIME_MS = 4 * 3600_000

/** Marks every queued or running help `stopped`; a running process learns at its next heartbeat. */
export async function stopHelps(
  trx: Transaction<Database> | Kysely<Database>,
  where: { approvalId: string } | { runId: string },
  now: Date,
): Promise<void> {
  let query = trx
    .updateTable('helps')
    .set({ status: 'stopped', ended_at: now })
    .where('status', 'in', ['queued', 'running'])
  query =
    'approvalId' in where
      ? query.where('approval_id', '=', where.approvalId)
      : query.where('run_id', '=', where.runId)
  await query.execute()
}

export class HelpService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly bus: Bus,
    private readonly clock: () => Date,
  ) {}

  /** Records a help for a question of a current request and queues it; nothing else moves. */
  async create(
    approvalId: string,
    questionIndex: number | null,
    mode: QuestionHelpMode,
  ): Promise<HelpView> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('approval_requests')
        .innerJoin('runs', 'runs.id', 'approval_requests.run_id')
        .innerJoin('tasks', 'tasks.id', 'runs.task_id')
        .select([
          'approval_requests.id',
          'approval_requests.run_id',
          'approval_requests.kind',
          'approval_requests.question',
          'approval_requests.context_md',
          'approval_requests.options',
          'approval_requests.recommendation',
          'approval_requests.questions',
          'approval_requests.status',
          'runs.task_id',
          'runs.block',
          'tasks.state as task_state',
        ])
        .where('approval_requests.id', '=', approvalId)
        .forUpdate()
        .executeTakeFirst()
      if (row === undefined) throw new NotFoundError('No such approval request')
      if (row.kind === 'proposal')
        throw new ConflictError('A proposal is settled on the Proposals tab; its help is there', {
          reason: 'not_offered',
        })
      const block = row.block as Block | null
      if (
        !isCurrent({
          status: row.status,
          taskState: row.task_state,
          blockCause: block?.cause ?? null,
        })
      )
        throw new ConflictError(`This request is ${row.status}; reload to see the latest`, {
          status: row.status,
        })
      const asked = questionOf(
        {
          kind: row.kind as ApprovalKind,
          question: row.question,
          context_md: row.context_md,
          options: row.options as ApprovalOption[],
          recommendation: row.recommendation,
          questions: (row.questions ?? null) as BatchQuestion[] | null,
        },
        questionIndex,
      )
      if (asked === null) throw new ValidationError('No such question', { field: 'question_index' })

      const existing = await trx
        .selectFrom('helps')
        .select(COLUMNS)
        .where('approval_id', '=', approvalId)
        .where('status', 'in', ['queued', 'running'])
        .execute()
      const busy = existing.find(
        (help) => help.question_index === questionIndex && help.mode === mode,
      )
      // A second press while one is in flight starts nothing more.
      if (busy !== undefined && hasInFlight(existing, questionIndex, mode)) return busy as HelpView

      const created = await trx
        .insertInto('helps')
        .values({
          run_id: row.run_id,
          approval_id: approvalId,
          decision: 'question',
          subject: null,
          question_index: questionIndex,
          mode,
          status: 'queued',
          result: null,
          reason: null,
          phase_id: null,
          runner_id: null,
          started_at: null,
          ended_at: null,
          last_heartbeat_at: null,
          created_at: this.clock(),
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow()
      await publish(trx, { topic: 'help.queued', taskId: row.task_id })
      await publish(trx, { topic: 'help.updated', taskId: row.task_id })
      return created as HelpView
    })
  }

  /**
   * A task's helps worth showing: for each question and mode, or each decision and mode, the
   * latest help, and the latest succeeded one when the latest is not that. A decision help that
   * is retired, or whose subject no longer stands, is left out.
   */
  async forTask(taskId: string): Promise<HelpView[]> {
    const all = (await this.db
      .selectFrom('helps')
      .innerJoin('runs', 'runs.id', 'helps.run_id')
      .select([...COLUMNS, 'helps.retired_at'])
      .where('runs.task_id', '=', taskId)
      .where('helps.status', '!=', 'stopped')
      .orderBy('helps.created_at', 'desc')
      .execute()) as (HelpView & { retired_at: Date | null })[]
    const facts = all.some((help) => help.decision !== 'question')
      ? await readSubjectFacts(this.db, taskId)
      : null
    const rows = all.filter(
      (help) =>
        help.decision === 'question' ||
        (help.retired_at === null &&
          facts !== null &&
          stands(help.decision as CardDecision, help.subject as HelpSubject, facts)),
    )
    const keep = new Set<string>()
    const seenLatest = new Set<string>()
    const seenDone = new Set<string>()
    for (const help of rows) {
      const key =
        help.decision === 'question'
          ? `${help.approval_id}/${help.question_index ?? ''}/${help.mode}`
          : `${help.decision}/${help.mode}`
      if (!seenLatest.has(key)) {
        seenLatest.add(key)
        keep.add(help.id)
      }
      if (help.status === 'succeeded' && !seenDone.has(key)) {
        seenDone.add(key)
        keep.add(help.id)
      }
    }
    return rows.filter((help) => keep.has(help.id)).map(({ retired_at: _retired, ...help }) => help)
  }

  /**
   * Asks for a decision help (R4): with the task row locked, checks the decision is offered,
   * then queues a help run and its help. A second press while one is in flight answers with it.
   */
  async createForDecision(
    taskId: string,
    decision: string,
    mode: string,
    proposalId?: string,
  ): Promise<HelpView> {
    if (!(decision in DECISION_MODES) || decision === 'question')
      throw new ValidationError('Unknown decision', { field: 'decision' })
    const known = decision as CardDecision
    const modes: readonly string[] = DECISION_MODES[known]
    if (!modes.includes(mode)) throw new ValidationError('Unknown mode', { field: 'mode' })
    if (known === 'proposal' && proposalId === undefined)
      throw new ValidationError('proposal_id is required for a proposal', { field: 'proposal_id' })
    if (known !== 'proposal' && proposalId !== undefined)
      throw new ValidationError('proposal_id belongs to the proposal decision only', {
        field: 'proposal_id',
      })
    return this.db.transaction().execute(async (trx) => {
      const task = await trx
        .selectFrom('tasks')
        .select('state')
        .where('id', '=', taskId)
        .forUpdate()
        .executeTakeFirst()
      if (task === undefined) throw new NotFoundError('No such task')
      const facts = await readSubjectFacts(trx, taskId)
      if (
        !offered(known, facts) ||
        (known === 'proposal' && !facts.openProposals.includes(proposalId ?? ''))
      )
        throw new ConflictError(`Help with ${decision.replaceAll('_', ' ')} is not offered now`, {
          reason: 'not_offered',
          state: task.state,
        })
      const busy = await trx
        .selectFrom('helps')
        .innerJoin('runs', 'runs.id', 'helps.run_id')
        .select(COLUMNS)
        .where('runs.task_id', '=', taskId)
        .where('helps.decision', '=', known)
        .where('helps.mode', '=', mode as HelpMode)
        .where('helps.status', 'in', ['queued', 'running'])
        .$if(known === 'proposal', (qb) =>
          qb.where(sql<boolean>`helps.subject->>'proposal_id' = ${proposalId ?? ''}`),
        )
        .executeTakeFirst()
      if (busy !== undefined) return busy as HelpView
      const last = await trx
        .selectFrom('runs')
        .select((eb) => eb.fn.max('number').as('n'))
        .where('task_id', '=', taskId)
        .where('kind', '=', 'help')
        .executeTakeFirst()
      const run = await trx
        .insertInto('runs')
        .values({
          task_id: taskId,
          kind: 'help',
          number: (last?.n ?? 0) + 1,
          status: 'queued',
          queued_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const created = await trx
        .insertInto('helps')
        .values({
          run_id: run.id,
          approval_id: null,
          decision: known,
          subject: JSON.stringify(subjectOf(known, facts, proposalId)),
          question_index: null,
          mode: mode as HelpMode,
          status: 'queued',
          result: null,
          reason: null,
          phase_id: null,
          runner_id: null,
          started_at: null,
          ended_at: null,
          last_heartbeat_at: null,
          created_at: this.clock(),
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow()
      await publish(trx, { topic: 'help.queued', taskId })
      await publish(trx, { topic: 'help.updated', taskId })
      return created as HelpView
    })
  }

  /** Takes the oldest queued help, waiting up to `waitMs` for one. */
  async claim(runnerId: string, waitMs: number): Promise<HelpWork | null> {
    const first = await this.tryClaim(runnerId)
    if (first !== null || waitMs === 0) return first
    await this.bus.next('help.queued', waitMs)
    return this.tryClaim(runnerId)
  }

  private async tryClaim(runnerId: string): Promise<HelpWork | null> {
    return this.db.transaction().execute(async (trx) => {
      const help = await trx
        .selectFrom('helps')
        .select(['id', 'run_id', 'approval_id', 'question_index', 'mode', 'decision', 'subject'])
        .where('status', '=', 'queued')
        .orderBy('created_at')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst()
      if (help === undefined) return null
      const now = this.clock()
      const phaseId = crypto.randomUUID()
      await trx
        .updateTable('helps')
        .set({
          status: 'running',
          runner_id: runnerId,
          phase_id: phaseId,
          started_at: now,
          last_heartbeat_at: now,
        })
        .where('id', '=', help.id)
        .execute()
      const earlier = await trx
        .selectFrom('helps')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('run_id', '=', help.run_id)
        .where('status', '!=', 'queued')
        .executeTakeFirstOrThrow()
      const row = await trx
        .selectFrom('runs')
        .innerJoin('tasks', 'tasks.id', 'runs.task_id')
        .innerJoin('projects', 'projects.id', 'tasks.project_id')
        .select([
          'runs.id',
          'runs.number',
          'runs.worktree_path',
          'tasks.id as task_id',
          'tasks.number as task_number',
          'tasks.title',
          'tasks.budget_usd',
          'projects.key',
          'projects.id as project_id',
          'projects.repo_path',
          'projects.base_branch',
        ])
        .where('runs.id', '=', help.run_id)
        .executeTakeFirstOrThrow()
      await publish(trx, { topic: 'help.updated', taskId: row.task_id })
      const taskKey = `${row.key}-${row.task_number}`
      const decisionWork =
        help.decision === 'question'
          ? null
          : await this.decisionWork(trx, {
              taskId: row.task_id,
              taskKey,
              projectId: row.project_id,
              repoPath: row.repo_path,
              baseBranch: row.base_branch,
              subject: help.subject,
            })
      return {
        id: help.id,
        mode: help.mode,
        decision: help.decision,
        subject: help.subject,
        decision_work: decisionWork,
        approval_id: help.approval_id,
        question_index: help.question_index,
        phase_id: phaseId,
        attempt: Number(earlier.n),
        run: {
          id: row.id,
          number: row.number,
          worktree_path: row.worktree_path,
          task: {
            id: row.task_id,
            key: `${row.key}-${row.task_number}`,
            title: row.title,
            budget_usd: row.budget_usd === null ? null : Number(row.budget_usd),
          },
        },
      }
    })
  }

  /** The project, the links and the checkout source a decision help works from (R8). */
  private async decisionWork(
    trx: Transaction<Database>,
    from: {
      taskId: string
      taskKey: string
      projectId: string
      repoPath: string
      baseBranch: string
      subject: HelpSubject | null
    },
  ): Promise<DecisionWork> {
    const links = await trx
      .selectFrom('project_links')
      .innerJoin('projects', 'projects.id', 'project_links.linked_project_id')
      .select([
        'projects.key',
        'projects.name',
        'project_links.note',
        'projects.repo_path',
        'projects.github_repo',
        'projects.base_branch',
      ])
      .where('project_links.project_id', '=', from.projectId)
      .orderBy('projects.key')
      .execute()
    let checkout: CheckoutSource = { source: 'base' }
    const subject = from.subject
    if (subject !== null && 'run_id' in subject) {
      if (subject.task_state === 'blocked')
        checkout = { source: 'paused_run', run_id: subject.run_id }
    } else if (subject !== null && 'pr_run_id' in subject) {
      const run = await trx
        .selectFrom('runs')
        .select(['number', 'branch'])
        .where('id', '=', subject.pr_run_id)
        .executeTakeFirst()
      if (run !== undefined)
        checkout = {
          source: 'pull_request',
          branch: run.branch ?? `board/${from.taskKey}-r${run.number}`,
        }
    } else if (subject !== null && 'delivery_run_id' in subject) {
      if (subject.task_state === 'review' && subject.delivery_run_id !== null) {
        const run = await trx
          .selectFrom('runs')
          .select(['number', 'branch'])
          .where('id', '=', subject.delivery_run_id)
          .executeTakeFirst()
        if (run !== undefined)
          checkout = {
            source: 'pr_branch',
            branch: run.branch ?? `board/${from.taskKey}-r${run.number}`,
          }
      }
    }
    return { repo_path: from.repoPath, base_branch: from.baseBranch, links, checkout }
  }

  /** Which of these run ids are help runs that have ended: their leftovers can be removed. */
  async ended(runIds: string[]): Promise<string[]> {
    if (runIds.length === 0) return []
    const rows = await this.db
      .selectFrom('runs')
      .select('id')
      .where('id', 'in', runIds)
      .where('kind', '=', 'help')
      .where('status', 'in', ['succeeded', 'failed', 'cancelled'])
      .execute()
    return rows.map((row) => row.id)
  }

  /**
   * Records liveness of the helps a runner carries, and names those to end: stopped, failed, or
   * not its own. A help that saved its result is not told to stop; its process ends itself.
   */
  async heartbeat(runnerId: string, helpIds: string[]): Promise<{ stop: string[] }> {
    if (helpIds.length === 0) return { stop: [] }
    await this.db
      .updateTable('helps')
      .set({ last_heartbeat_at: this.clock() })
      .where('id', 'in', helpIds)
      .where('runner_id', '=', runnerId)
      .where('status', '=', 'running')
      .execute()
    const rows = await this.db
      .selectFrom('helps')
      .select(['id', 'status', 'runner_id'])
      .where('id', 'in', helpIds)
      .execute()
    const known = new Map(rows.map((row) => [row.id, row]))
    return {
      stop: helpIds.filter((id) => {
        const row = known.get(id)
        if (row === undefined || row.runner_id !== runnerId) return true
        return row.status === 'stopped' || row.status === 'failed' || row.status === 'queued'
      }),
    }
  }

  /** A token limited to the asking run and to the helper's tools. */
  async issueToken(helpId: string): Promise<{ token: string }> {
    const help = await this.db
      .selectFrom('helps')
      .select(['run_id', 'status'])
      .where('id', '=', helpId)
      .executeTakeFirst()
    if (help?.status !== 'running')
      throw new ConflictError('Tokens are issued only for a running help')
    const { token, hash } = newToken()
    await this.db
      .insertInto('run_tokens')
      .values({
        run_id: help.run_id,
        help_id: helpId,
        token_hash: hash,
        expires_at: new Date(this.clock().getTime() + TOKEN_LIFETIME_MS),
      })
      .execute()
    return { token }
  }

  /** The runner's word that the process ended without a result. Saved or stopped helps stay. */
  async fail(helpId: string, reason: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const help = await trx
        .updateTable('helps')
        .set({
          status: 'failed',
          reason: reason.slice(0, HELP_LIMITS.reason),
          ended_at: this.clock(),
        })
        .where('id', '=', helpId)
        .where('status', 'in', ['queued', 'running'])
        .returning(['run_id', 'phase_id'])
        .executeTakeFirst()
      if (help === undefined) return
      if (help.phase_id !== null)
        await trx
          .updateTable('phases')
          .set({ status: 'failed', interrupted: true, ended_at: this.clock() })
          .where('id', '=', help.phase_id)
          .where('status', 'in', ['running', 'paused'])
          .execute()
      await endHelpRun(
        trx,
        help.run_id,
        'failed',
        reason.slice(0, HELP_LIMITS.reason),
        this.clock(),
      )
      await this.announce(trx, help.run_id)
    })
  }

  /**
   * A runner that moved to new code gives back a help it claimed and did not start: it is
   * queued again, for any daemon to claim. A help already stopped, failed or saved stays.
   */
  async release(helpId: string, runnerId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const help = await trx
        .updateTable('helps')
        .set({
          status: 'queued',
          runner_id: null,
          phase_id: null,
          started_at: null,
          last_heartbeat_at: null,
        })
        .where('id', '=', helpId)
        .where('status', '=', 'running')
        .where('runner_id', '=', runnerId)
        .returning('run_id')
        .executeTakeFirst()
      if (help === undefined) return
      const run = await trx
        .selectFrom('runs')
        .select('task_id')
        .where('id', '=', help.run_id)
        .executeTakeFirstOrThrow()
      await publish(trx, { topic: 'help.queued', taskId: run.task_id })
      await this.announce(trx, help.run_id)
    })
  }

  /** The helper's save. Refused for a help that is not running, and for an invalid result. */
  async save(
    helpId: string,
    input: HelpResultInput & DecisionResultInput,
  ): Promise<{ ok: true } | { error: string }> {
    return this.db.transaction().execute(async (trx) => {
      const own = await trx
        .selectFrom('helps')
        .innerJoin('runs', 'runs.id', 'helps.run_id')
        .select([
          'helps.id',
          'helps.run_id',
          'helps.status',
          'helps.mode',
          'helps.decision',
          'helps.subject',
          'runs.task_id',
        ])
        .where('helps.id', '=', helpId)
        .forUpdate('helps')
        .executeTakeFirst()
      if (own === undefined) return { error: 'No such help.' }
      if (own.decision !== 'question') return this.saveDecision(trx, own, input)
      const help = await trx
        .selectFrom('helps')
        .innerJoin('approval_requests', 'approval_requests.id', 'helps.approval_id')
        .select([
          'helps.id',
          'helps.run_id',
          'helps.status',
          'helps.mode',
          'helps.question_index',
          'approval_requests.kind',
          'approval_requests.question',
          'approval_requests.context_md',
          'approval_requests.options',
          'approval_requests.recommendation',
          'approval_requests.questions',
        ])
        .where('helps.id', '=', helpId)
        .forUpdate('helps')
        .executeTakeFirst()
      if (help === undefined) return { error: 'No such help.' }
      if (help.status !== 'running')
        return { error: `This help is ${help.status}; nothing was saved. End your turn now.` }
      const asked = questionOf(
        {
          kind: help.kind as ApprovalKind,
          question: help.question,
          context_md: help.context_md,
          options: help.options as ApprovalOption[],
          recommendation: help.recommendation,
          questions: (help.questions ?? null) as BatchQuestion[] | null,
        },
        help.question_index,
      )
      const findings = checkHelpResult(help.mode as QuestionHelpMode, asked?.options ?? [], input)
      if (findings.length > 0)
        return {
          error: [
            'The result was not saved:',
            ...findings.map((f) => `- ${f.field}: ${f.code.replaceAll('_', ' ')}`),
          ].join('\n'),
        }
      await trx
        .updateTable('helps')
        .set({
          status: 'succeeded',
          result: JSON.stringify(resultOf(help.mode as QuestionHelpMode, input)),
          ended_at: this.clock(),
        })
        .where('id', '=', helpId)
        .execute()
      await endHelpRun(trx, help.run_id, 'succeeded', null, this.clock())
      await this.announce(trx, help.run_id)
      return { ok: true as const }
    })
  }

  /**
   * A decision help's save. `stands` is checked before the status: a subject that no longer
   * stands saves nothing, and stops a help that is still running.
   */
  private async saveDecision(
    trx: Transaction<Database>,
    help: {
      id: string
      run_id: string
      status: HelpStatus
      mode: HelpMode
      decision: HelpDecision
      subject: HelpSubject | null
      task_id: string
    },
    input: DecisionResultInput,
  ): Promise<{ ok: true } | { error: string }> {
    const facts = await readSubjectFacts(trx, help.task_id)
    const now = this.clock()
    if (help.subject === null || !stands(help.decision as CardDecision, help.subject, facts)) {
      if (help.status === 'running') {
        await trx
          .updateTable('helps')
          .set({ status: 'stopped', ended_at: now })
          .where('id', '=', help.id)
          .execute()
        await endHelpRun(trx, help.run_id, 'cancelled', null, now)
        await publish(trx, { topic: 'help.updated', taskId: help.task_id })
      }
      return { error: 'This decision is no longer offered; nothing was saved. End your turn now.' }
    }
    if (help.status !== 'running')
      return { error: `This help is ${help.status}; nothing was saved. End your turn now.` }
    const mode = help.mode as DecisionResultMode
    const subject = help.subject
    const proposal =
      mode === 'advise' && 'proposal_id' in subject
        ? (await proposalsOf(trx, help.task_id)).find((view) => view.id === subject.proposal_id)
        : undefined
    const findings = checkDecisionResult(mode, input, {
      recommendable: recommendableActions(facts),
      checkedAgainst: specRead(facts).checkedAgainst,
      ...(proposal === undefined ? {} : { offeredVariants: proposal.offered }),
    })
    if (findings.length > 0)
      return {
        error: [
          'The result was not saved:',
          ...findings.map((f) => `- ${f.field}: ${f.code.replaceAll('_', ' ')}`),
        ].join('\n'),
      }
    await trx
      .updateTable('helps')
      .set({
        status: 'succeeded',
        result: JSON.stringify(
          decisionResultOf(
            mode,
            input,
            mode === 'code_review' ? await checkoutCommit(trx, help.run_id) : null,
          ),
        ),
        ended_at: now,
      })
      .where('id', '=', help.id)
      .execute()
    await endHelpRun(trx, help.run_id, 'succeeded', null, now)
    await publish(trx, { topic: 'help.updated', taskId: help.task_id })
    return { ok: true as const }
  }

  private async announce(trx: Transaction<Database>, runId: string): Promise<void> {
    const run = await trx
      .selectFrom('runs')
      .select('task_id')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    await publish(trx, { topic: 'help.updated', taskId: run.task_id })
  }
}
