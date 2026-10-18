import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { Bus } from '../../shared/bus.js'
import { publish } from '../../shared/bus.js'
import { ConflictError, UnauthorizedError } from '../../shared/errors.js'
import { hashToken, newToken } from '../../shared/tokens.js'
import type { SpecCriterion } from '../../shared/vocabulary.js'
import { moveTask } from '../tasks/task.moves.js'
import { effectOf, type Effect } from './event-effects.js'
import type { RunnerEvent } from './runner.schemas.js'

export interface Work {
  kind: 'start'
  run: {
    id: string
    number: number
    kind: 'spec' | 'delivery'
    spec_version: number
    task: {
      id: string
      key: string
      title: string
      description_md: string
      budget_usd: number | null
    }
    spec: { version: number; body_md: string; criteria: SpecCriterion[] }
    project: {
      key: string
      repo_path: string
      github_repo: string
      base_branch: string
      test_command: string
    }
  }
}

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

  /** Skips — and cancels — queued runs whose task is no longer Ready. */
  private async tryClaim(runnerId: string): Promise<Work | null> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const outcome = await this.db.transaction().execute(async (trx) => {
        const run = await trx
          .selectFrom('runs')
          .select(['id', 'task_id'])
          .where('status', '=', 'queued')
          .orderBy('created_at')
          .limit(1)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst()
        if (run === undefined) return 'none' as const
        const task = await trx
          .selectFrom('tasks')
          .select('state')
          .where('id', '=', run.task_id)
          .forUpdate()
          .executeTakeFirstOrThrow()
        if (task.state !== 'ready') {
          await trx
            .updateTable('runs')
            .set({ status: 'cancelled', ended_at: this.clock() })
            .where('id', '=', run.id)
            .execute()
          return 'skipped' as const
        }
        await moveTask(trx, run.task_id, 'claim')
        const now = this.clock()
        await trx
          .updateTable('runs')
          .set({ status: 'running', runner_id: runnerId, started_at: now, last_heartbeat_at: now })
          .where('id', '=', run.id)
          .execute()
        return this.work(trx, run.id)
      })
      if (outcome === 'none') return null
      if (outcome !== 'skipped') return outcome
    }
    return null
  }

  private async work(trx: Transaction<Database>, runId: string): Promise<Work> {
    const row = await trx
      .selectFrom('runs')
      .innerJoin('tasks', 'tasks.id', 'runs.task_id')
      .innerJoin('projects', 'projects.id', 'tasks.project_id')
      .innerJoin('specs', (join) =>
        join
          .onRef('specs.task_id', '=', 'runs.task_id')
          .onRef('specs.version', '=', 'runs.spec_version'),
      )
      .select([
        'runs.id',
        'runs.kind',
        'runs.spec_version',
        'tasks.id as task_id',
        'tasks.number',
        'tasks.title',
        'tasks.description_md',
        'tasks.budget_usd',
        'projects.key',
        'projects.repo_path',
        'projects.github_repo',
        'projects.base_branch',
        'projects.test_command',
        'specs.body_md',
        'specs.criteria',
      ])
      .where('runs.id', '=', runId)
      .executeTakeFirstOrThrow()
    // Compared inside the database: a timestamp read into a Date loses its microseconds, and
    // the run would then not count itself.
    const { count } = await trx
      .selectFrom('runs')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('task_id', '=', row.task_id)
      .where('created_at', '<=', (eb) =>
        eb.selectFrom('runs as self').select('self.created_at').where('self.id', '=', runId),
      )
      .executeTakeFirstOrThrow()
    return {
      kind: 'start',
      run: {
        id: row.id,
        number: count,
        kind: row.kind,
        spec_version: row.spec_version,
        task: {
          id: row.task_id,
          key: `${row.key}-${row.number}`,
          title: row.title,
          description_md: row.description_md,
          budget_usd: row.budget_usd === null ? null : Number(row.budget_usd),
        },
        spec: { version: row.spec_version, body_md: row.body_md, criteria: row.criteria ?? [] },
        project: {
          key: row.key,
          repo_path: row.repo_path,
          github_repo: row.github_repo,
          base_branch: row.base_branch,
          test_command: row.test_command,
        },
      },
    }
  }

  async heartbeat(runnerId: string, runIds: string[]): Promise<{ cancel: string[] }> {
    if (runIds.length === 0) return { cancel: [] }
    await this.db
      .updateTable('runs')
      .set({ last_heartbeat_at: this.clock() })
      .where('id', 'in', runIds)
      .where('runner_id', '=', runnerId)
      .execute()
    const rows = await this.db
      .selectFrom('runs')
      .select('id')
      .where('id', 'in', runIds)
      .where('cancel_requested', '=', true)
      .execute()
    return { cancel: rows.map((row) => row.id) }
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
            ended_at: effect.at,
          }))
          .where('id', '=', effect.phaseId)
          .where('run_id', '=', context.runId)
          .execute()
        return
      case 'run_end': {
        const status = effect.outcome === 'review' ? 'succeeded' : effect.outcome
        await trx
          .updateTable('runs')
          .set({
            status,
            ended_at: effect.at,
            failure_reason: effect.reason,
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
        if (task.state !== 'running') return
        await moveTask(trx, context.taskId, effect.outcome === 'review' ? 'finish_review' : 'fail')
        return
      }
    }
  }
}
