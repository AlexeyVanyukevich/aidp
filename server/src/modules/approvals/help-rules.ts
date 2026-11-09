import type {
  ApprovalKind,
  HelpMode,
  HelpResult,
  HelpStatus,
  QuestionHelpMode,
} from '../../shared/vocabulary.js'
import type { ApprovalOption, BatchQuestion, Finding } from './approval-rules.js'

/**
 * The rules of a help (AIDP-9 spec): what a helper may save, which question a help is for, and
 * when a request is current. Pure: no database, no clock.
 */

export const HELP_LIMITS = {
  text: 4_000,
  part: 4_000,
  /** The longest a failure reason is kept. */
  reason: 500,
} as const

/** Heartbeats missing this long, and a running help is lost (the same window as a run's). */
export const HELP_LOST_AFTER_MS = 90_000

/** At most this many helps run at once on one runner, beside its run. */
export const HELP_SLOTS = 3

/** What a helper's save may carry; every field optional, the rules say which are needed. */
export interface HelpResultInput {
  option_id?: string | undefined
  text?: string | undefined
  reasoning?: string | undefined
  unsure?: string | undefined
  asked?: string | undefined
  matters?: string | undefined
  leads_to?: string | undefined
}

const blank = (text: string | undefined | null) =>
  text === undefined || text === null || text.trim() === ''

/** Whether the owner's answer form is showing this request: open, or expired on a Blocked card. */
export function isCurrent(approval: {
  status: string
  taskState: string
  blockCause: string | null
}): boolean {
  return (
    approval.status === 'open' ||
    (approval.status === 'expired' &&
      approval.taskState === 'blocked' &&
      approval.blockCause === 'approval_expired')
  )
}

/** A question to help with: the request's own, or one of a batch. */
export interface HelpQuestion {
  question: string
  context_md: string | null
  options: ApprovalOption[]
  recommendation: string | null
}

/** The question a help is for, or null when the index names none. */
export function questionOf(
  approval: {
    kind: ApprovalKind
    question: string
    context_md: string | null
    options: ApprovalOption[]
    recommendation: string | null
    questions: BatchQuestion[] | null
  },
  index: number | null,
): HelpQuestion | null {
  if (approval.kind === 'questions') {
    const asked = index === null ? undefined : (approval.questions ?? [])[index]
    return asked === undefined ? null : asked
  }
  return index === null ? approval : null
}

/** What a saved result must be. The first finding names the field to fix. */
export function checkHelpResult(
  mode: QuestionHelpMode,
  options: ApprovalOption[],
  input: HelpResultInput,
): Finding[] {
  const findings: Finding[] = []
  const long = (field: string, value: string | undefined, limit: number) => {
    if (value !== undefined && value.length > limit) findings.push({ field, code: 'too_long' })
  }
  if (mode === 'suggest') {
    if (input.option_id === undefined && blank(input.text))
      findings.push({ field: 'option_id', code: 'required' })
    if (input.option_id !== undefined && !options.some((option) => option.id === input.option_id))
      findings.push({ field: 'option_id', code: 'unknown_option' })
    if (blank(input.reasoning)) findings.push({ field: 'reasoning', code: 'required' })
    if (blank(input.unsure)) findings.push({ field: 'unsure', code: 'required' })
    for (const field of ['asked', 'matters', 'leads_to'] as const)
      if (input[field] !== undefined) findings.push({ field, code: 'not_allowed' })
    long('text', input.text, HELP_LIMITS.text)
    long('reasoning', input.reasoning, HELP_LIMITS.part)
    long('unsure', input.unsure, HELP_LIMITS.part)
    return findings
  }
  for (const field of ['option_id', 'text', 'reasoning', 'unsure'] as const)
    if (input[field] !== undefined) findings.push({ field, code: 'not_allowed' })
  for (const field of ['asked', 'matters', 'leads_to'] as const) {
    if (blank(input[field])) findings.push({ field, code: 'required' })
    long(field, input[field], HELP_LIMITS.part)
  }
  return findings
}

/** The result as it is stored: only the fields of its mode. */
export function resultOf(mode: QuestionHelpMode, input: HelpResultInput): HelpResult {
  if (mode === 'explain')
    return {
      mode,
      asked: (input.asked ?? '').trim(),
      matters: (input.matters ?? '').trim(),
      leads_to: (input.leads_to ?? '').trim(),
    }
  return {
    mode,
    ...(input.option_id === undefined ? {} : { option_id: input.option_id }),
    ...(blank(input.text) ? {} : { text: (input.text ?? '').trim() }),
    reasoning: (input.reasoning ?? '').trim(),
    unsure: (input.unsure ?? '').trim(),
  }
}

/** A help that still counts as in flight: its button is busy. */
export const IN_FLIGHT: HelpStatus[] = ['queued', 'running']

/** Whether a help of this mode is already in flight for the question. */
export function hasInFlight(
  helps: { question_index: number | null; mode: HelpMode; status: HelpStatus }[],
  index: number | null,
  mode: HelpMode,
): boolean {
  return helps.some(
    (help) =>
      help.question_index === index && help.mode === mode && IN_FLIGHT.includes(help.status),
  )
}

/** Which running helps lost their process: no heartbeat for the window. */
export function lostHelps(
  helps: { id: string; status: HelpStatus; lastHeartbeatAt: Date | null }[],
  now: Date,
): string[] {
  return helps
    .filter(
      (help) =>
        help.status === 'running' &&
        help.lastHeartbeatAt !== null &&
        now.getTime() - help.lastHeartbeatAt.getTime() > HELP_LOST_AFTER_MS,
    )
    .map((help) => help.id)
}
