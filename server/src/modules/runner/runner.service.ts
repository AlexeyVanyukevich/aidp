import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { Bus } from '../../shared/bus.js'
import { publish } from '../../shared/bus.js'
import { ConflictError, UnauthorizedError } from '../../shared/errors.js'
import { hashToken, newToken } from '../../shared/tokens.js'
import type { Checkpoint, SpecCriterion } from '../../shared/vocabulary.js'
import { allowedFiles, approvedMigrations, type Answer } from '../approvals/approval-rules.js'
import { openApproval } from '../approvals/approval.service.js'
import { planAnswers, previousPlans } from '../tasks/plan-history.js'
import { loadPlanHistory } from '../tasks/plan-history.queries.js'
import { moveFacts, moveTask } from '../tasks/task.moves.js'
import { effectOf, type Effect } from './event-effects.js'
import type { RunnerEvent } from './runner.schemas.js'

export interface RunWork {
  id: string
  number: number
  kind: 'spec' | 'delivery'
  /** A delivery run's approved version; a spec run's version it redrafts, or null. */
  spec_version: number | null
  /** What the owner asked a redraft to change. */
  note: string | null
  task: {
    id: string
    key: string
    title: string
    description_md: string
    budget_usd: number | null
  }
  /** The spec at `spec_version`: null for a first draft. */
  spec: { version: number; body_md: string; criteria: SpecCriterion[] } | null
  project: {
    key: string
    repo_path: string
    github_repo: string
    base_branch: string
    /**
     * A delivery run's value is the run's own fixed text, set at its first claim and unchanged
     * by later choices, edits or default changes; a spec run's is read at claim.
     */
    test_command: string
    setup_command: string | null
  }
  /** The projects this one links to, ordered by key: the runner makes read-only checkouts. */
  links: {
    key: string
    name: string
    note: string
    repo_path: string
    github_repo: string
    base_branch: string
  }[]
  /**
   * A delivery run's earlier plans for a planner starting again: the newest on this spec
   * version, and the newest accepted one when that was not. Empty for a run holding a copied plan.
   */
  previous_plans: { run: number; accepted: boolean; body_md: string }[]
  plan_answers: { run: number; approved: boolean; text: string }[]
  /** The plan a Re-run copied into this run; the run starts no planner. */
  kept_plan: { artifact_id: string; from_run: number } | null
}

/** What a claim hands the runner (spec §6): a run to start, to resume, or to clean up after. */
export type Work =
  | { kind: 'start'; run: RunWork }
  | {
      kind: 'resume'
      run: RunWork
      checkpoint: Checkpoint
      message: string | null
      allowed_files: string[]
      approved_migrations: string[]
    }
  | { kind: 'cleanup'; run: { id: string; repo_path: string; worktree_path: string | null } }

const TOKEN_LIFETIME_MS = 12 * 3600_000
const RETIRE_GRACE_MS = 5 * 60_000

export class RunnerService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly bus: Bus,
    private readonly clock: () => Date,
  ) {}

  async claim(runnerId: string, waitMs: number): Promise<Work | null> {
    const first = await this.tryClaim(runnerId)
    if (first !== null || waitMs === 0) return first
    await this.bus.next('run.queued', waitMs)
    return this.tryClaim(runnerId)
  }

  /**
   * Takes the oldest queued work of any kind. A start whose card has moved on — out of Ready for
   * a delivery run, out of Spec draft for a spec run — is skipped, and cancelled, rather than
   * handed over.
   */
  private async tryClaim(runnerId: string): Promise<Work | null> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const outcome = await this.db.transaction().execute(async (trx) => {
        const run = await trx
          .selectFrom('runs')
          .select(['id', 'task_id', 'kind', 'pending', 'resume_message'])
          .where('queued_at', 'is not', null)
          .orderBy('queued_at')
          .orderBy('created_at')
          .limit(1)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst()
        if (run === undefined) return 'none' as const
        const now = this.clock()

        if (run.pending === 'cleanup') {
          await trx
            .updateTable('runs')
            .set({ pending: null, queued_at: null })
            .where('id', '=', run.id)
            .execute()
          const row = await trx
            .selectFrom('runs')
            .innerJoin('tasks', 'tasks.id', 'runs.task_id')
            .innerJoin('projects', 'projects.id', 'tasks.project_id')
            .select(['projects.repo_path', 'runs.worktree_path'])
            .where('runs.id', '=', run.id)
            .executeTakeFirstOrThrow()
          return { kind: 'cleanup' as const, run: { id: run.id, ...row } }
        }

        const claimedRun = {
          status: 'running' as const,
          runner_id: runnerId,
          last_heartbeat_at: now,
          pending: null,
          queued_at: null,
        }
        if (run.pending === 'resume') {
          // The answer or the Resume already moved the card to Running.
          await trx.updateTable('runs').set(claimedRun).where('id', '=', run.id).execute()
          return {
            kind: 'resume' as const,
            run: await this.work(trx, run.id),
            checkpoint: await this.checkpointFor(trx, run.id),
            message: run.resume_message,
            allowed_files: await this.allowedFilesFor(trx, run.id),
            approved_migrations: await this.approvedMigrationsFor(trx, run.id),
          }
        }

        const task = await trx
          .selectFrom('tasks')
          .select('state')
          .where('id', '=', run.task_id)
          .forUpdate()
          .executeTakeFirstOrThrow()
        // A draft's card is already in Spec draft: claiming it moves nothing (slice 3 spec, §4).
        if (task.state !== (run.kind === 'spec' ? 'spec_draft' : 'ready')) {
          await trx
            .updateTable('runs')
            .set({ status: 'cancelled', ended_at: now, queued_at: null })
            .where('id', '=', run.id)
            .execute()
          return 'skipped' as const
        }
        if (run.kind === 'delivery') await moveTask(trx, run.task_id, 'claim')
        // Fixed at the first claim: a later choice, edit or default change does not reach it.
        const fixed =
          run.kind === 'delivery'
            ? { test_command: await this.chosenCommand(trx, run.task_id) }
            : {}
        await trx
          .updateTable('runs')
          .set({ ...claimedRun, ...fixed, started_at: now })
          .where('id', '=', run.id)
          .execute()
        return { kind: 'start' as const, run: await this.work(trx, run.id) }
      })
      if (outcome === 'none') return null
      if (outcome !== 'skipped') return outcome
    }
    return null
  }

  /**
   * The checkpoint the runner last sent. A run paused before its runner sent any — a slice 1
   * runner — gets one derived from its records: the latest phase, its session, and the plan.
   */
  private async checkpointFor(trx: Transaction<Database>, runId: string): Promise<Checkpoint> {
    const run = await trx
      .selectFrom('runs')
      .select(['checkpoint', 'current_phase'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    if (run.checkpoint !== null) return run.checkpoint
    const phase = await trx
      .selectFrom('phases')
      .select(['id', 'name', 'attempt', 'session_id'])
      .where('run_id', '=', runId)
      .orderBy('started_at', 'desc')
      .executeTakeFirst()
    const plan = await trx
      .selectFrom('artifacts')
      .select('id')
      .where('run_id', '=', runId)
      .where('kind', '=', 'plan')
      .orderBy('created_at', 'desc')
      .executeTakeFirst()
    const stage = phase?.name ?? run.current_phase
    return {
      stage: stage === 'plan' || stage === 'build' || stage === 'verify' ? stage : 'prepare',
      attempt: phase?.attempt ?? 1,
      phase_id: phase?.id ?? null,
      session:
        phase?.session_id == null ? null : { id: phase.session_id, baseline: {}, reported: {} },
      head: null,
      plan_artifact_id: plan?.id ?? null,
      failing_report_id: null,
    }
  }

  /** The latest plan's files, and every file an answered out-of-plan request allowed. */
  private async allowedFilesFor(trx: Transaction<Database>, runId: string): Promise<string[]> {
    const plan = await trx
      .selectFrom('artifacts')
      .select('data')
      .where('run_id', '=', runId)
      .where('kind', '=', 'plan')
      .orderBy('created_at', 'desc')
      .executeTakeFirst()
    const steps = ((plan?.data ?? {}) as { steps?: { files?: string[] }[] }).steps ?? []
    const answered = await trx
      .selectFrom('approval_requests')
      .select(['kind', 'files', 'answer'])
      .where('run_id', '=', runId)
      .where('status', '=', 'answered')
      .orderBy('answered_at')
      .execute()
    return allowedFiles(
      steps.flatMap((step) => step.files ?? []),
      answered.map((row) => ({ ...row, answer: (row.answer ?? {}) as Answer })),
    )
  }

  /** The migrations the owner allowed for this run. */
  private async approvedMigrationsFor(
    trx: Transaction<Database>,
    runId: string,
  ): Promise<string[]> {
    const answered = await trx
      .selectFrom('approval_requests')
      .select(['kind', 'files', 'answer'])
      .where('run_id', '=', runId)
      .where('status', '=', 'answered')
      .where('kind', '=', 'migration')
      .orderBy('answered_at')
      .execute()
    return approvedMigrations(
      answered.map((row) => ({ ...row, answer: (row.answer ?? {}) as Answer })),
    )
  }

  /** The text of the task's chosen test command, else of its project's default. */
  private async chosenCommand(trx: Transaction<Database>, taskId: string): Promise<string> {
    const row = await trx
      .selectFrom('tasks')
      .select((eb) => [
        eb
          .selectFrom('project_test_commands as c')
          .select('c.command')
          .whereRef('c.id', '=', 'tasks.test_command_id')
          .as('chosen'),
        eb
          .selectFrom('project_test_commands as d')
          .select('d.command')
          .whereRef('d.project_id', '=', 'tasks.project_id')
          .where('d.is_default', '=', true)
          .as('fallback'),
      ])
      .where('tasks.id', '=', taskId)
      .executeTakeFirstOrThrow()
    return row.chosen ?? row.fallback ?? 'npm test'
  }

  private async work(trx: Transaction<Database>, runId: string): Promise<RunWork> {
    const row = await trx
      .selectFrom('runs')
      .innerJoin('tasks', 'tasks.id', 'runs.task_id')
      .innerJoin('projects', 'projects.id', 'tasks.project_id')
      // A first draft has no spec to join.
      .leftJoin('specs', (join) =>
        join
          .onRef('specs.task_id', '=', 'runs.task_id')
          .onRef('specs.version', '=', 'runs.spec_version'),
      )
      .select([
        'runs.id',
        'runs.kind',
        'runs.number as run_number',
        'runs.spec_version',
        'runs.note',
        'runs.test_command as run_test_command',
        'projects.id as project_id',
        'specs.version',
        'tasks.id as task_id',
        'tasks.number',
        'tasks.title',
        'tasks.description_md',
        'tasks.budget_usd',
        'projects.key',
        'projects.repo_path',
        'projects.github_repo',
        'projects.base_branch',
        'projects.setup_command',
        'specs.body_md',
        'specs.criteria',
      ])
      .where('runs.id', '=', runId)
      .executeTakeFirstOrThrow()
    const kept =
      row.kind === 'delivery'
        ? await trx
            .selectFrom('artifacts')
            .select(['id', 'copied_from_run'])
            .where('run_id', '=', runId)
            .where('kind', '=', 'plan')
            .where('copied_from_run', 'is not', null)
            .orderBy('created_at', 'desc')
            .executeTakeFirst()
        : undefined
    let previous: RunWork['previous_plans'] = []
    let answers: RunWork['plan_answers'] = []
    if (row.kind === 'delivery' && kept === undefined && row.spec_version !== null) {
      const { plans, approvals } = await loadPlanHistory(trx, row.task_id)
      previous = previousPlans(plans, approvals, row.spec_version, runId).map(
        ({ plan, accepted }) => ({ run: plan.runNumber, accepted, body_md: plan.bodyMd }),
      )
      answers = planAnswers(approvals, row.spec_version, runId)
    }
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
      .where('project_links.project_id', '=', row.project_id)
      .orderBy('projects.key')
      .execute()
    return {
      id: row.id,
      number: row.run_number,
      kind: row.kind,
      spec_version: row.spec_version,
      note: row.note,
      task: {
        id: row.task_id,
        key: `${row.key}-${row.number}`,
        title: row.title,
        description_md: row.description_md,
        budget_usd: row.budget_usd === null ? null : Number(row.budget_usd),
      },
      spec:
        row.version === null || row.body_md === null
          ? null
          : { version: row.version, body_md: row.body_md, criteria: row.criteria ?? [] },
      project: {
        key: row.key,
        repo_path: row.repo_path,
        github_repo: row.github_repo,
        base_branch: row.base_branch,
        test_command: row.run_test_command ?? (await this.chosenCommand(trx, row.task_id)),
        setup_command: row.setup_command,
      },
      links,
      previous_plans: previous,
      plan_answers: answers,
      kept_plan:
        kept === undefined || kept.copied_from_run === null
          ? null
          : { artifact_id: kept.id, from_run: kept.copied_from_run },
    }
  }

  /**
   * Records liveness, and tells the runner which of its runs to stop — cancelled, blocked, or no
   * longer its own — and which have paused, so it can end their processes (spec §6, §8).
   */
  async heartbeat(
    runnerId: string,
    runIds: string[],
  ): Promise<{ cancel: string[]; pause: string[] }> {
    if (runIds.length === 0) return { cancel: [], pause: [] }
    await this.db
      .updateTable('runs')
      .set({ last_heartbeat_at: this.clock() })
      .where('id', 'in', runIds)
      .where('runner_id', '=', runnerId)
      .where('status', 'in', ['running', 'paused'])
      .execute()
    const rows = await this.db
      .selectFrom('runs')
      .select(['id', 'status', 'runner_id', 'cancel_requested'])
      .where('id', 'in', runIds)
      .execute()
    const mine = (row: (typeof rows)[number]) => row.runner_id === runnerId
    return {
      cancel: rows
        .filter(
          (row) =>
            row.cancel_requested ||
            !mine(row) ||
            row.status === 'blocked' ||
            row.status === 'cancelled',
        )
        .map((row) => row.id),
      pause: rows
        .filter((row) => mine(row) && !row.cancel_requested && row.status === 'paused')
        .map((row) => row.id),
    }
  }

  async issueToken(runId: string): Promise<{ token: string }> {
    const run = await this.db
      .selectFrom('runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirst()
    if (run?.status !== 'running')
      throw new ConflictError('Tokens are issued only for a running run')
    const { token, hash } = newToken()
    await this.db
      .insertInto('run_tokens')
      .values({
        run_id: runId,
        token_hash: hash,
        expires_at: new Date(this.clock().getTime() + TOKEN_LIFETIME_MS),
      })
      .execute()
    return { token }
  }

  async retire(token: string): Promise<void> {
    const until = new Date(this.clock().getTime() + RETIRE_GRACE_MS)
    await this.db
      .updateTable('run_tokens')
      .set((eb) => ({ expires_at: eb.fn('least', [eb.ref('expires_at'), eb.val(until)]) }))
      .where('token_hash', '=', hashToken(token))
      .execute()
  }

  /** One transaction: a malformed event refuses the whole batch, so a replay is all or nothing. */
  async ingest(
    context: { runId: string; taskId: string },
    events: RunnerEvent[],
  ): Promise<{ accepted: number }> {
    if (events.some((event) => event.run_id !== context.runId)) throw new UnauthorizedError()
    const effects = events.map((event) => effectOf(event))
    return this.db.transaction().execute(async (trx) => {
      let accepted = 0
      for (const [index, event] of events.entries()) {
        const inserted = await trx
          .insertInto('events')
          .values({
            id: event.id,
            run_id: event.run_id,
            phase_id: event.phase_id,
            ts: event.ts,
            type: event.type,
            agent: event.agent,
            model: event.model,
            tool: event.tool,
            target: event.target,
            status: event.status,
            duration_ms: event.duration_ms,
            input: event.usage.input,
            output: event.usage.output,
            cache_read: event.usage.cache_read,
            cache_write: event.usage.cache_write,
            payload: JSON.stringify(event.payload),
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .returning('id')
          .executeTakeFirst()
        if (inserted === undefined) continue
        accepted += 1
        const effect = effects[index]
        if (effect !== undefined) await this.apply(trx, context, effect)
      }
      if (accepted > 0)
        await publish(trx, { topic: 'run.event', runId: context.runId, taskId: context.taskId })
      return { accepted }
    })
  }

  private async apply(
    trx: Transaction<Database>,
    context: { runId: string; taskId: string },
    effect: Effect,
  ): Promise<void> {
    switch (effect.kind) {
      case 'phase_start':
        await trx
          .insertInto('phases')
          .values({
            id: effect.phaseId,
            run_id: context.runId,
            name: effect.name,
            attempt: effect.attempt,
            agent: effect.agent,
            model: effect.model,
            status: 'running',
            session_id: effect.sessionId,
            started_at: effect.at,
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .execute()
        await trx
          .updateTable('runs')
          .set((eb) => ({
            current_phase: effect.name,
            fix_loops:
              effect.name === 'build'
                ? eb.fn('greatest', [eb.ref('fix_loops'), eb.val(effect.attempt - 1)])
                : eb.ref('fix_loops'),
          }))
          .where('id', '=', context.runId)
          .execute()
        return
      case 'phase_end':
        await trx
          .updateTable('phases')
          .set((eb) => ({
            status: effect.status,
            summary_md: effect.summary,
            reported_cost:
              effect.reportedCost === null ? null : JSON.stringify(effect.reportedCost),
            session_id: eb.fn.coalesce(eb.val(effect.sessionId), eb.ref('session_id')),
            // Once interrupted, always: a later clean process does not undo the lost usage.
            ...(effect.interrupted ? { interrupted: true } : {}),
            ended_at: effect.at,
          }))
          .where('id', '=', effect.phaseId)
          .where('run_id', '=', context.runId)
          .execute()
        return
      case 'phase_resume':
        await trx
          .updateTable('phases')
          .set((eb) => ({
            status: 'running',
            session_id: eb.fn.coalesce(eb.val(effect.sessionId), eb.ref('session_id')),
          }))
          .where('id', '=', effect.phaseId)
          .where('run_id', '=', context.runId)
          .execute()
        return
      case 'checkpoint':
        await trx
          .updateTable('runs')
          .set({ checkpoint: JSON.stringify(effect.checkpoint) })
          .where('id', '=', context.runId)
          .execute()
        return
      case 'block': {
        await trx
          .updateTable('runs')
          .set({ status: 'blocked', block: JSON.stringify(effect.block) })
          .where('id', '=', context.runId)
          .execute()
        await trx
          .updateTable('phases')
          .set({ status: 'paused' })
          .where('run_id', '=', context.runId)
          .where('status', '=', 'running')
          .execute()
        const task = await trx
          .selectFrom('tasks')
          .select('state')
          .where('id', '=', context.taskId)
          .executeTakeFirstOrThrow()
        // A card the owner already moved — a Cancel — stays where it is.
        if (task.state === 'running' || task.state === 'spec_draft')
          await moveTask(trx, context.taskId, 'block')
        return
      }
      case 'plan_approval':
        await openApproval(
          trx,
          {
            id: effect.approvalId,
            runId: context.runId,
            taskId: context.taskId,
            phaseId: effect.phaseId,
            kind: 'plan',
            question: effect.question,
            options: [],
            context_md: effect.contextMd,
          },
          this.clock(),
          { recordEvent: false },
        )
        return
      case 'run_end': {
        // A draft that ended well but saved nothing failed: there is nothing to review.
        const saved =
          effect.outcome !== 'drafted' ||
          (await trx
            .selectFrom('specs')
            .select('id')
            .where('run_id', '=', context.runId)
            .executeTakeFirst()) !== undefined
        const outcome = saved ? effect.outcome : 'failed'
        await trx
          .updateTable('runs')
          .set({
            status: outcome === 'review' || outcome === 'drafted' ? 'succeeded' : outcome,
            ended_at: effect.at,
            failure_reason: saved ? effect.reason : 'the spec-writer saved no spec',
            pr_number: effect.prNumber,
            pr_url: effect.prUrl,
            branch: effect.branch,
            worktree_path: effect.worktreePath,
          })
          .where('id', '=', context.runId)
          .execute()
        if (effect.prUrl !== null) {
          await trx
            .insertInto('artifacts')
            .values({
              run_id: context.runId,
              phase_id: null,
              kind: 'pr',
              body_md: `[#${effect.prNumber}](${effect.prUrl})`,
              uri: effect.prUrl,
              data: null,
            })
            .execute()
        }
        const task = await trx
          .selectFrom('tasks')
          .select('state')
          .where('id', '=', context.taskId)
          .executeTakeFirstOrThrow()
        // A run the owner cancelled has already moved its card; its own report moves nothing.
        if (task.state === 'spec_draft') {
          await moveTask(
            trx,
            context.taskId,
            outcome === 'drafted' ? 'finish_draft' : 'drop_draft',
            await moveFacts(trx, context.taskId),
          )
          return
        }
        if (task.state !== 'running') return
        await moveTask(trx, context.taskId, outcome === 'review' ? 'finish_review' : 'fail')
        return
      }
    }
  }
}
