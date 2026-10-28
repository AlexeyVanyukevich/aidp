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
  id: string
  runId: string
  runNumber: number
  specVersion: number | null
  contextMd: string | null
  optionId: string | null
  /** The words of the answer, if it carried any. */
  answerText: string | null
  answeredAt: Date
}

/** What the owner wrote at an earlier plan gate. */
export interface PlanAnswer {
  run: number
  approved: boolean
  text: string
}

/**
 * The owner's worded answers at plan gates of earlier runs on this spec version, oldest answered
 * first, ties by approval id. Blank answers and the current run's own are left out.
 */
export function planAnswers(
  approvals: PlanApprovalRecord[],
  specVersion: number,
  excludeRunId?: string,
): PlanAnswer[] {
  return approvals
    .filter((a) => a.specVersion === specVersion && a.runId !== excludeRunId)
    .map((a) => ({ a, text: (a.answerText ?? '').trim() }))
    .filter(({ text }) => text !== '')
    .sort(
      (x, y) =>
        x.a.answeredAt.getTime() - y.a.answeredAt.getTime() ||
        (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0),
    )
    .map(({ a, text }) => ({ run: a.runNumber, approved: a.optionId === 'approve', text }))
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
