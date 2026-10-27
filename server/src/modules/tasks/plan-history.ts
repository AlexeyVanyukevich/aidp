/**
 * Which earlier plans of a task count as accepted, which one a Re-run keeps, and which ones a
 * re-planning planner is shown. Pure: the records come from `plan-history.queries.ts`.
 */

export interface PlanRecord {
  id: string
  runId: string
  runNumber: number
  specVersion: number | null
  createdAt: Date
  bodyMd: string
  confidence: string | null
  /** The number of the run this plan was copied from, when a Re-run kept it. */
  copiedFromRun: number | null
}

/** An answered `plan` approval. */
export interface PlanApprovalRecord {
  runId: string
  contextMd: string | null
  optionId: string | null
}

/**
 * Accepted: confidence `high`, a copy, or the plan an approval showed. An approval is tied to a
 * plan by its text alone, in the same run: phase and time say nothing about which plan the
 * owner saw.
 */
export function isAccepted(plan: PlanRecord, approvals: PlanApprovalRecord[]): boolean {
  if (plan.confidence === 'high' || plan.copiedFromRun !== null) return true
  return approvals.some(
    (a) => a.optionId === 'approve' && a.runId === plan.runId && a.contextMd === plan.bodyMd,
  )
}

const newestFirst = (plans: PlanRecord[]) =>
  plans
    .map((plan, index) => ({ plan, index }))
    .sort((a, b) => b.plan.createdAt.getTime() - a.plan.createdAt.getTime() || b.index - a.index)
    .map(({ plan }) => plan)

/** The newest accepted plan on this spec version, or none. */
export function planToKeep(
  plans: PlanRecord[],
  approvals: PlanApprovalRecord[],
  specVersion: number,
): PlanRecord | undefined {
  return newestFirst(plans.filter((p) => p.specVersion === specVersion)).find((p) =>
    isAccepted(p, approvals),
  )
}

export interface PreviousPlan {
  plan: PlanRecord
  accepted: boolean
}

/**
 * What a planner starting again is shown: the newest plan saved on this spec version, and, when
 * that one was never accepted, the newest accepted one before it. The current run's own plans
 * are left out.
 */
export function previousPlans(
  plans: PlanRecord[],
  approvals: PlanApprovalRecord[],
  specVersion: number,
  excludeRunId?: string,
): PreviousPlan[] {
  const sorted = newestFirst(
    plans.filter((p) => p.specVersion === specVersion && p.runId !== excludeRunId),
  )
  const newest = sorted[0]
  if (newest === undefined) return []
  if (isAccepted(newest, approvals)) return [{ plan: newest, accepted: true }]
  const older = sorted.slice(1).find((p) => isAccepted(p, approvals))
  return [
    { plan: newest, accepted: false },
    ...(older === undefined ? [] : [{ plan: older, accepted: true }]),
  ]
}
