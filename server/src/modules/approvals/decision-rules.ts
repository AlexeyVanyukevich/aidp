import type { BlockCause, HelpSubject, TaskState } from '../../shared/vocabulary.js'

/**
 * Every decision the owner makes on a card where a helper may advise (AIDP-105 spec). Pure: no
 * database, no clock. A new decision control is added here first.
 */

export const DECISIONS = [
  'question',
  'spec_review',
  'stopped_run',
  'mark_done',
  'proposal',
] as const
export type Decision = (typeof DECISIONS)[number]

/** The modes each decision offers. */
export const DECISION_MODES = {
  question: ['suggest', 'explain'],
  spec_review: ['review', 'restate'],
  stopped_run: ['recommend'],
  mark_done: ['check'],
  proposal: ['advise'],
} as const satisfies Record<Decision, readonly string[]>

export type DecisionMode = (typeof DECISION_MODES)[Decision][number]

/** The decisions that are not a question: the ones with a run and a subject of their own. */
export type CardDecision = Exclude<Decision, 'question'>

/** The actions the card offers a stopped run. */
export const STOPPED_RUN_ACTIONS = [
  'resume',
  'cancel',
  'rerun_again',
  'rerun_keep',
  'mark_done',
] as const
export type StoppedRunAction = (typeof STOPPED_RUN_ACTIONS)[number]

/** What the rules read. */
export interface DecisionFacts {
  taskState: TaskState
  blockCause: BlockCause | null
  /** A plan a Re-run could keep. */
  planToKeep: boolean
  /** Whether the stopped run left a checkpoint to resume from. */
  checkpoint: boolean
  /** Whether the card's question is still current (`isCurrent`). */
  approvalCurrent: boolean
  /** The ids of the task's open proposals. */
  openProposals: readonly string[]
}

/** Whether the stopped run is one the owner can recommend an action for. */
function stopped(facts: DecisionFacts): boolean {
  return (
    facts.taskState === 'failed' ||
    (facts.taskState === 'blocked' && facts.blockCause !== 'approval_expired')
  )
}

export function offered(decision: Decision, facts: DecisionFacts): boolean {
  switch (decision) {
    case 'question':
      return facts.approvalCurrent
    case 'spec_review':
      return facts.taskState === 'spec_review'
    case 'stopped_run':
      return stopped(facts)
    case 'mark_done':
      return ['backlog', 'spec_review', 'review', 'failed'].includes(facts.taskState)
    case 'proposal':
      return facts.openProposals.length > 0
  }
}

/** The actions the card offers a stopped run, in the order of its buttons. */
export function stoppedRunActions(facts: DecisionFacts): StoppedRunAction[] {
  if (facts.taskState === 'blocked')
    return facts.blockCause === 'approval_expired' ? ['cancel'] : ['resume', 'cancel']
  if (facts.taskState === 'failed')
    return ['rerun_again', 'mark_done', ...(facts.planToKeep ? (['rerun_keep'] as const) : [])]
  return []
}

/** The actions a helper may recommend: Resume is left out when there is no checkpoint. */
export function recommendableActions(facts: DecisionFacts): StoppedRunAction[] {
  return stoppedRunActions(facts).filter((action) => action !== 'resume' || facts.checkpoint)
}

/** Every decision of the card that is offered now. */
export function offeredDecisions(facts: DecisionFacts): Decision[] {
  return DECISIONS.filter((decision) => offered(decision, facts))
}

/** What a help recorded when it was created (R5). */
export type Subject = HelpSubject

/** The facts a subject is compared with. */
export interface SubjectFacts extends DecisionFacts {
  latestSpecVersion: number | null
  /** The approved version, null when none is approved. */
  approvedSpecVersion: number | null
  /** The task's latest spec or delivery run. */
  latestRunId: string | null
  latestDeliveryRunId: string | null
  /** The block's cause on the latest run, null when none. */
  runBlock: BlockCause | null
}

/** The subject the facts give a decision now. */
export function subjectOf(
  decision: CardDecision,
  facts: SubjectFacts,
  proposalId?: string,
): Subject {
  if (decision === 'proposal') return { proposal_id: proposalId ?? '' }
  if (decision === 'spec_review') return { spec_version: facts.latestSpecVersion ?? 0 }
  if (decision === 'stopped_run')
    return {
      run_id: facts.latestRunId ?? '',
      task_state: facts.taskState,
      block: facts.taskState === 'failed' ? null : facts.runBlock,
    }
  return {
    task_state: facts.taskState,
    // The spec Mark done reads: the approved one in Review and Failed, the latest in Spec review.
    spec_version: specRead(facts).version,
    delivery_run_id: facts.latestDeliveryRunId,
  }
}

/** True while the decision is offered and the help's recorded subject equals the facts. */
export function stands(decision: CardDecision, subject: Subject, facts: SubjectFacts): boolean {
  if (!offered(decision, facts)) return false
  // A proposal's help stands while that proposal is open.
  if (decision === 'proposal')
    return 'proposal_id' in subject && facts.openProposals.includes(subject.proposal_id)
  const now = subjectOf(decision, facts)
  return JSON.stringify(sorted(subject)) === JSON.stringify(sorted(now))
}

function sorted(subject: Subject): Record<string, unknown> {
  return Object.fromEntries(Object.entries(subject).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** What Mark done's check reads for the task's state (R11's `checked_against`). */
export function specRead(
  facts: Pick<SubjectFacts, 'taskState' | 'latestSpecVersion' | 'approvedSpecVersion'>,
): {
  checkedAgainst: 'approved_spec' | 'latest_spec' | 'description'
  version: number | null
} {
  if (facts.taskState === 'spec_review')
    return { checkedAgainst: 'latest_spec', version: facts.latestSpecVersion }
  if (facts.taskState === 'review' || facts.taskState === 'failed')
    return { checkedAgainst: 'approved_spec', version: facts.approvedSpecVersion }
  return { checkedAgainst: 'description', version: null }
}
