import type {
  ApprovalKind,
  ApprovalOption,
  ApprovalStatus,
  ApprovalView,
  TaskState,
} from '../types'

/** An option button's name: its label, and the recommendation in words (spec §11). */
export function optionName(option: ApprovalOption, recommendation: string | null): string {
  return option.id === recommendation ? `${option.label} (recommended)` : option.label
}

export function headingFor(status: ApprovalStatus): string {
  return status === 'expired' ? 'Unanswered question' : 'Open question'
}

export function fieldLabel(kind: ApprovalKind): string {
  return kind === 'plan' ? 'Changes to ask for' : 'Your answer'
}

/** What an answered request's line says it was answered with. */
export function answerSummary(approval: ApprovalView): string {
  if (approval.status === 'withdrawn') return 'Withdrawn: the run was cancelled.'
  const chosen = approval.options.find((o) => o.id === approval.answer?.option_id)
  return [chosen?.label, approval.answer?.text?.trim() || undefined]
    .filter((part) => part !== undefined)
    .join(' — ')
}

/**
 * The request the card waits on: an open one, or an expired one while the card it blocked is
 * still Blocked — it stays answerable then (spec §2).
 */
export function currentApproval(
  approvals: ApprovalView[],
  state: TaskState,
): ApprovalView | undefined {
  return approvals.find(
    (a) => a.status === 'open' || (a.status === 'expired' && state === 'blocked'),
  )
}
