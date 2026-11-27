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
  /** The criteria this plan withdraws at the plan gate; absent reads as none. */
  withdrawn?: { criterion: string; answer: string }[]
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
  /** The spec version the answer was given on. */
  specVersion: number | null
  approved: boolean
  text: string
}

/**
 * The owner's worded answers at plan gates of any run of this task on any spec version, oldest
 * answered first, ties by approval id. Blank answers are left out; the current run's own are
 * kept. Each carries the version it was given on.
 */
export function planAnswers(approvals: PlanApprovalRecord[]): PlanAnswer[] {
  return approvals
    .map((a) => ({ a, text: (a.answerText ?? '').trim() }))
    .filter(({ text }) => text !== '')
    .sort(
      (x, y) =>
        x.a.answeredAt.getTime() - y.a.answeredAt.getTime() ||
        (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0),
    )
    .map(({ a, text }) => ({
      run: a.runNumber,
      specVersion: a.specVersion,
      approved: a.optionId === 'approve',
      text,
    }))
}

/** The answers given on one spec version: what Verify and a withdrawal may rely on. */
export function answersOn(answers: PlanAnswer[], specVersion: number): PlanAnswer[] {
  return answers.filter((a) => a.specVersion === specVersion)
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

/** The newest plan of one run that `isAccepted` accepts, or none. */
export function acceptedPlanOf(
  plans: PlanRecord[],
  approvals: PlanApprovalRecord[],
  runId: string,
): PlanRecord | undefined {
  return newestFirst(plans.filter((p) => p.runId === runId)).find((p) => isAccepted(p, approvals))
}

export interface PreviousPlan {
  plan: PlanRecord
  accepted: boolean
  specVersion: number | null
}

/**
 * What a planner starting again is shown: the newest plan saved on this spec version, and, when
 * that one was never accepted, the newest accepted one before it. The current run's own plans
 * are left out. When no earlier run saved a plan on this version, the same rule applies to the
 * newest earlier version on which one did (AIDP-55).
 */
export function previousPlans(
  plans: PlanRecord[],
  approvals: PlanApprovalRecord[],
  specVersion: number,
  excludeRunId?: string,
): PreviousPlan[] {
  const others = plans.filter((p) => p.runId !== excludeRunId)
  let version = specVersion
  let sorted = newestFirst(others.filter((p) => p.specVersion === version))
  if (sorted.length === 0) {
    const earlier = others
      .flatMap((p) =>
        p.specVersion !== null && p.specVersion < specVersion ? [p.specVersion] : [],
      )
      .sort((x, y) => y - x)[0]
    if (earlier === undefined) return []
    version = earlier
    sorted = newestFirst(others.filter((p) => p.specVersion === version))
  }
  const newest = sorted[0]!
  if (isAccepted(newest, approvals)) return [{ plan: newest, accepted: true, specVersion: version }]
  const older = sorted.slice(1).find((p) => isAccepted(p, approvals))
  return [
    { plan: newest, accepted: false, specVersion: version },
    ...(older === undefined ? [] : [{ plan: older, accepted: true, specVersion: version }]),
  ]
}

/**
 * The owner's note on the plan a run builds from: the trimmed words of the Approve plan answer
 * that accepted it. A copied plan follows `copiedFromRun` back to the run whose gate approved
 * it. `null` when no approval exists (a high-confidence plan) or its words are blank.
 */
export function planNote(
  plans: PlanRecord[],
  approvals: PlanApprovalRecord[],
  runId: string,
): string | null {
  const seen = new Set<string>()
  let current = runId
  for (;;) {
    if (seen.has(current)) return null
    seen.add(current)
    const plan = acceptedPlanOf(plans, approvals, current)
    if (plan === undefined) return null
    if (plan.copiedFromRun === null) {
      const approval = approvals
        .filter(
          (a) => a.optionId === 'approve' && a.runId === plan.runId && a.contextMd === plan.bodyMd,
        )
        .sort(
          (x, y) =>
            y.answeredAt.getTime() - x.answeredAt.getTime() ||
            (x.id < y.id ? 1 : x.id > y.id ? -1 : 0),
        )[0]
      const text = (approval?.answerText ?? '').trim()
      return text === '' ? null : text
    }
    const source = plans.find((p) => p.runNumber === plan.copiedFromRun && p.runId !== plan.runId)
    if (source === undefined) return null
    current = source.runId
  }
}
