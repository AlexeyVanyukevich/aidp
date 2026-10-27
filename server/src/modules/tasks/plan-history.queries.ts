import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { PlanApprovalRecord, PlanRecord } from './plan-history.js'

/** Every plan of a task's delivery runs, and every `plan` approval the owner answered. */
export async function loadPlanHistory(
  db: Kysely<Database>,
  taskId: string,
): Promise<{ plans: PlanRecord[]; approvals: PlanApprovalRecord[] }> {
  const plans = await db
    .selectFrom('artifacts')
    .innerJoin('runs', 'runs.id', 'artifacts.run_id')
    .select([
      'artifacts.id',
      'artifacts.run_id',
      'artifacts.body_md',
      'artifacts.data',
      'artifacts.copied_from_run',
      'artifacts.created_at',
      'runs.number',
      'runs.spec_version',
    ])
    .where('runs.task_id', '=', taskId)
    .where('runs.kind', '=', 'delivery')
    .where('artifacts.kind', '=', 'plan')
    .orderBy('artifacts.created_at')
    .execute()
  const approvals = await db
    .selectFrom('approval_requests')
    .innerJoin('runs', 'runs.id', 'approval_requests.run_id')
    .select([
      'approval_requests.run_id',
      'approval_requests.context_md',
      'approval_requests.answer',
    ])
    .where('runs.task_id', '=', taskId)
    .where('runs.kind', '=', 'delivery')
    .where('approval_requests.kind', '=', 'plan')
    .where('approval_requests.status', '=', 'answered')
    .execute()
  return {
    plans: plans.map((row) => ({
      id: row.id,
      runId: row.run_id,
      runNumber: row.number,
      specVersion: row.spec_version,
      createdAt: row.created_at,
      bodyMd: row.body_md,
      confidence: (row.data as { confidence?: string } | null)?.confidence ?? null,
      copiedFromRun: row.copied_from_run,
    })),
    approvals: approvals.map((row) => ({
      runId: row.run_id,
      contextMd: row.context_md,
      optionId: (row.answer as { option_id?: string } | null)?.option_id ?? null,
    })),
  }
}
