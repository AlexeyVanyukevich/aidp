import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { Block, Stage } from '../../shared/vocabulary.js'
import { publish } from '../../shared/bus.js'
import { HELP_LOST_AFTER_MS } from '../approvals/help-rules.js'
import { endHelpRun } from '../approvals/help.service.js'
import { moveTask } from '../tasks/task.moves.js'
import {
  APPROVAL_TTL_MS,
  LOST_AFTER_MS,
  sweepDecisions,
  type SweepDecision,
} from './sweep-rules.js'

/** The stage a blocked run will resume from: its checkpoint's, else the phase it was in. */
async function stageOf(trx: Transaction<Database>, runId: string): Promise<Stage | null> {
  const run = await trx
    .selectFrom('runs')
    .select(['checkpoint', 'current_phase'])
    .where('id', '=', runId)
    .executeTakeFirstOrThrow()
  if (run.checkpoint !== null) return run.checkpoint.stage
  const phase = run.current_phase
  return phase === 'plan' || phase === 'build' || phase === 'verify' ? phase : null
}

/**
 * Blocks the runs whose runner stopped reporting, and the cards whose question went unanswered
 * for 48 hours (spec §8). Each decision is re-checked in its own transaction: a heartbeat or an
 * answer may have arrived since the candidates were read.
 */
export class Sweeper {
  private lastTick: Date | null = null
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: () => Date,
    private readonly intervalMs: number,
    private readonly log: { warn(obj: object, msg: string): void },
  ) {}

  async tick(): Promise<SweepDecision> {
    const now = this.clock()
    const [runs, approvals, helps] = await Promise.all([
      this.db
        .selectFrom('runs')
        .select(['id', 'status', 'last_heartbeat_at as lastHeartbeatAt'])
        .where('status', '=', 'running')
        .execute(),
      this.db
        .selectFrom('approval_requests')
        .select(['id', 'status', 'created_at as createdAt'])
        .where('status', '=', 'open')
        .execute(),
      this.db
        .selectFrom('helps')
        .select(['id', 'status', 'last_heartbeat_at as lastHeartbeatAt'])
        .where('status', '=', 'running')
        .execute(),
    ])
    const decision = sweepDecisions({
      now,
      lastTick: this.lastTick,
      intervalMs: this.intervalMs,
      runs,
      approvals,
      helps,
    })
    this.lastTick = now
    if (decision.rearm) return decision
    for (const runId of decision.lost) await this.lose(runId, now)
    for (const helpId of decision.lostHelps) await this.loseHelp(helpId, now)
    for (const approvalId of decision.expired) await this.expire(approvalId, now)
    return decision
  }

  private async lose(runId: string, now: Date): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const run = await trx
        .updateTable('runs')
        .set({ status: 'blocked' })
        .where('id', '=', runId)
        .where('status', '=', 'running')
        .where('last_heartbeat_at', '<', new Date(now.getTime() - LOST_AFTER_MS))
        .returning(['task_id', 'kind'])
        .executeTakeFirst()
      if (run === undefined) return
      if (run.kind === 'title' || run.kind === 'rephrase') {
        await this.loseSideRun(trx, runId, now)
        return
      }
      const block: Block = { cause: 'runner_lost', stage: await stageOf(trx, runId) }
      await trx
        .updateTable('runs')
        .set({ block: JSON.stringify(block) })
        .where('id', '=', runId)
        .execute()
      // The process died with its runner, or outlived it: either way its usage is not all known.
      await trx
        .updateTable('phases')
        .set({ status: 'paused', interrupted: true })
        .where('run_id', '=', runId)
        .where('status', '=', 'running')
        .where('name', '!=', 'help')
        .execute()
      const task = await trx
        .selectFrom('tasks')
        .select('state')
        .where('id', '=', run.task_id)
        .executeTakeFirstOrThrow()
      // A delivery run's card runs; a draft's drafts (slice 3 spec, §4).
      if (task.state === 'running' || task.state === 'spec_draft')
        await moveTask(trx, run.task_id, 'block')
    })
  }

  /** A title or rephrase run is never blocked or resumed: it fails, and its card stays put. */
  private async loseSideRun(trx: Transaction<Database>, runId: string, now: Date): Promise<void> {
    await trx
      .updateTable('runs')
      .set({
        status: 'failed',
        ended_at: now,
        failure_reason: 'the runner was lost',
        pending: 'cleanup',
        queued_at: now,
      })
      .where('id', '=', runId)
      .execute()
    await trx
      .updateTable('phases')
      .set({ status: 'failed', interrupted: true, ended_at: now })
      .where('run_id', '=', runId)
      .where('status', '=', 'running')
      .execute()
    await publish(trx, { topic: 'run.queued', runId })
    const run = await trx
      .selectFrom('runs')
      .select('task_id')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    await publish(trx, { topic: 'task.updated', taskId: run.task_id })
  }

  /** A help whose process stopped heartbeating fails, and its Help phase closes with it. */
  private async loseHelp(helpId: string, now: Date): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const help = await trx
        .updateTable('helps')
        .set({ status: 'failed', reason: 'the helper stopped responding', ended_at: now })
        .where('id', '=', helpId)
        .where('status', '=', 'running')
        .where('last_heartbeat_at', '<', new Date(now.getTime() - HELP_LOST_AFTER_MS))
        .returning(['phase_id', 'run_id'])
        .executeTakeFirst()
      if (help === undefined) return
      if (help.phase_id !== null)
        await trx
          .updateTable('phases')
          .set({ status: 'failed', interrupted: true, ended_at: now })
          .where('id', '=', help.phase_id)
          .where('status', 'in', ['running', 'paused'])
          .execute()
      await endHelpRun(trx, help.run_id, 'failed', 'the helper stopped responding', now)
      const run = await trx
        .selectFrom('runs')
        .select('task_id')
        .where('id', '=', help.run_id)
        .executeTakeFirstOrThrow()
      await publish(trx, { topic: 'help.updated', taskId: run.task_id })
    })
  }

  private async expire(approvalId: string, now: Date): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const approval = await trx
        .updateTable('approval_requests')
        .set({ status: 'expired' })
        .where('id', '=', approvalId)
        .where('status', '=', 'open')
        .where('created_at', '<=', new Date(now.getTime() - APPROVAL_TTL_MS))
        .returning('run_id')
        .executeTakeFirst()
      if (approval === undefined) return
      const block: Block = {
        cause: 'approval_expired',
        stage: await stageOf(trx, approval.run_id),
      }
      const run = await trx
        .updateTable('runs')
        .set({ status: 'blocked', block: JSON.stringify(block) })
        .where('id', '=', approval.run_id)
        .returning('task_id')
        .executeTakeFirstOrThrow()
      const task = await trx
        .selectFrom('tasks')
        .select('state')
        .where('id', '=', run.task_id)
        .executeTakeFirstOrThrow()
      if (task.state === 'needs_approval') await moveTask(trx, run.task_id, 'expire')
    })
  }

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.log.warn({ err: error }, 'the sweeper failed'))
    }, this.intervalMs)
  }

  stop(): void {
    clearInterval(this.timer)
  }
}
