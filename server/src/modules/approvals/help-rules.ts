import type {
  ApprovalKind,
  HelpMode,
  HelpResult,
  HelpStatus,
  ProposalOutcome,
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

/** What a decision help's save may carry; every field optional, the mode says which are needed. */
export interface DecisionResultInput {
  verdict?: string | undefined
  findings?:
    | {
        kind: string
        where?: string | undefined
        text: string
        file?: string | undefined
        line?: number | undefined
        matters?: string | undefined
      }[]
    | undefined
  unsure?: string | undefined
  changes?: string | undefined
  requirements?: string | undefined
  left_out?: string | undefined
  why_stopped?: string | undefined
  action?: string | undefined
  reasoning?: string | undefined
  checked_against?: string | undefined
  produced?: string | undefined
  unfinished?: { where?: string | undefined; text: string }[] | undefined
  // The question fields: never allowed in a decision help.
  variant?: string | undefined
  option_id?: string | undefined
  text?: string | undefined
  asked?: string | undefined
  matters?: string | undefined
  leads_to?: string | undefined
}

/** What the board knows when it checks a decision help's result. */
export interface DecisionCheckFacts {
  /** Actions `recommendableActions` gives now. */
  recommendable: readonly string[]
  /** What Mark done reads for the task's state (R11). */
  checkedAgainst: string
  /** The variants a proposal offers now: what an advise help may recommend. */
  offeredVariants?: readonly string[]
}

const DECISION_FIELDS = {
  review: ['verdict', 'findings', 'unsure'],
  restate: ['changes', 'requirements', 'left_out'],
  recommend: ['why_stopped', 'action', 'reasoning', 'unsure'],
  check: ['checked_against', 'produced', 'unfinished', 'unsure'],
  advise: ['variant', 'reasoning', 'unsure'],
  code_review: ['verdict', 'findings', 'unsure'],
} as const

const ALL_RESULT_FIELDS = [
  'verdict',
  'findings',
  'unsure',
  'changes',
  'requirements',
  'left_out',
  'why_stopped',
  'action',
  'reasoning',
  'checked_against',
  'produced',
  'unfinished',
  'variant',
  'option_id',
  'text',
  'asked',
  'matters',
  'leads_to',
] as const

const ACTION_IDS = ['resume', 'cancel', 'rerun_again', 'rerun_keep', 'mark_done']
const FINDING_KINDS = ['missing', 'contradiction', 'uncheckable', 'risk']
const CODE_FINDING_KINDS = ['bug', 'breaks', 'duplicate', 'fit', 'test']
const FILE_LIMIT = 300
export type DecisionResultMode =
  'review' | 'restate' | 'recommend' | 'check' | 'advise' | 'code_review'
const LIST_LIMIT = 30
const WHERE_LIMIT = 100

/** A field to fix in a decision help's result, and why. */
export interface DecisionFinding {
  field: string
  code:
    | 'required'
    | 'not_allowed'
    | 'too_long'
    | 'too_many'
    | 'unknown_kind'
    | 'unknown_verdict'
    | 'unknown_action'
    | 'not_offered'
    | 'wrong_source'
    | 'invalid_line'
}

/** What a decision help's saved result must be. Each finding names the field to fix. */
export function checkDecisionResult(
  mode: DecisionResultMode,
  input: DecisionResultInput,
  facts: DecisionCheckFacts,
): DecisionFinding[] {
  const findings: DecisionFinding[] = []
  const allowed: readonly string[] = DECISION_FIELDS[mode]
  for (const field of ALL_RESULT_FIELDS)
    if (input[field] !== undefined && !allowed.includes(field))
      findings.push({ field, code: 'not_allowed' })
  const text = (field: keyof DecisionResultInput, required: boolean) => {
    const value = input[field] as string | undefined
    if (value === undefined) {
      if (required) findings.push({ field, code: 'required' })
      return
    }
    if (blank(value)) findings.push({ field, code: 'required' })
    else if (value.trim().length > HELP_LIMITS.text) findings.push({ field, code: 'too_long' })
  }
  const items = (
    field: 'findings' | 'unfinished',
    list: { kind?: string; where?: string | undefined; text: string }[] | undefined,
  ) => {
    if (list === undefined) return
    if (list.length > LIST_LIMIT) findings.push({ field, code: 'too_many' })
    for (const item of list) {
      if (field === 'findings' && !FINDING_KINDS.includes(item.kind ?? ''))
        findings.push({ field, code: 'unknown_kind' })
      if (blank(item.text)) findings.push({ field, code: 'required' })
      else if (item.text.trim().length > HELP_LIMITS.text)
        findings.push({ field, code: 'too_long' })
      if (item.where !== undefined && item.where.trim().length > WHERE_LIMIT)
        findings.push({ field, code: 'too_long' })
    }
  }

  const codeItems = () => {
    const list = input.findings
    if (list === undefined) return
    if (list.length > LIST_LIMIT) findings.push({ field: 'findings', code: 'too_many' })
    for (const item of list) {
      if (!CODE_FINDING_KINDS.includes(item.kind))
        findings.push({ field: 'findings', code: 'unknown_kind' })
      if (item.where !== undefined) findings.push({ field: 'findings', code: 'not_allowed' })
      if (blank(item.file)) findings.push({ field: 'findings', code: 'required' })
      else if ((item.file ?? '').trim().length > FILE_LIMIT)
        findings.push({ field: 'findings', code: 'too_long' })
      if (item.line !== undefined && (!Number.isInteger(item.line) || item.line < 1))
        findings.push({ field: 'findings', code: 'invalid_line' })
      for (const value of [item.text, item.matters]) {
        if (blank(value)) findings.push({ field: 'findings', code: 'required' })
        else if ((value ?? '').trim().length > HELP_LIMITS.text)
          findings.push({ field: 'findings', code: 'too_long' })
      }
    }
  }

  if (mode === 'code_review') {
    if (input.verdict !== 'changes' && input.verdict !== 'nothing_to_change')
      findings.push({
        field: 'verdict',
        code: input.verdict === undefined ? 'required' : 'unknown_verdict',
      })
    codeItems()
    const count = input.findings?.length ?? 0
    if (input.verdict === 'changes' && count === 0)
      findings.push({ field: 'findings', code: 'required' })
    if (input.verdict === 'nothing_to_change' && count > 0)
      findings.push({ field: 'findings', code: 'not_allowed' })
    text('unsure', true)
  } else if (mode === 'review') {
    if (input.verdict !== 'changes' && input.verdict !== 'nothing_to_change')
      findings.push({
        field: 'verdict',
        code: input.verdict === undefined ? 'required' : 'unknown_verdict',
      })
    items('findings', input.findings)
    const count = input.findings?.length ?? 0
    if (input.verdict === 'changes' && count === 0)
      findings.push({ field: 'findings', code: 'required' })
    if (input.verdict === 'nothing_to_change' && count > 0)
      findings.push({ field: 'findings', code: 'not_allowed' })
    text('unsure', true)
  } else if (mode === 'restate') {
    for (const field of ['changes', 'requirements', 'left_out'] as const) text(field, true)
  } else if (mode === 'recommend') {
    text('why_stopped', true)
    text('reasoning', true)
    text('unsure', true)
    if (input.action === undefined) findings.push({ field: 'action', code: 'required' })
    else if (!ACTION_IDS.includes(input.action))
      findings.push({ field: 'action', code: 'unknown_action' })
    else if (!facts.recommendable.includes(input.action))
      findings.push({ field: 'action', code: 'not_offered' })
  } else if (mode === 'advise') {
    text('reasoning', true)
    text('unsure', true)
    if (input.variant === undefined) findings.push({ field: 'variant', code: 'required' })
    else if (!(facts.offeredVariants ?? []).includes(input.variant))
      findings.push({ field: 'variant', code: 'not_offered' })
  } else {
    if (input.checked_against === undefined)
      findings.push({ field: 'checked_against', code: 'required' })
    else if (input.checked_against !== facts.checkedAgainst)
      findings.push({ field: 'checked_against', code: 'wrong_source' })
    text('produced', true)
    items('unfinished', input.unfinished)
    text('unsure', true)
  }
  return findings
}

/** The decision result as it is stored: only the fields of its mode, trimmed. */
export function decisionResultOf(
  mode: DecisionResultMode,
  input: DecisionResultInput,
  commit: string | null = null,
): HelpResult {
  const t = (value: string | undefined) => (value ?? '').trim()
  if (mode === 'code_review')
    return {
      mode,
      verdict: input.verdict === 'changes' ? 'changes' : 'nothing_to_change',
      findings: (input.findings ?? []).map((item) => ({
        kind: item.kind as 'bug' | 'breaks' | 'duplicate' | 'fit' | 'test',
        where: item.line === undefined ? t(item.file) : `${t(item.file)}:${item.line}`,
        text: t(item.text),
        matters: t(item.matters),
      })),
      unsure: t(input.unsure),
      commit,
    }
  const where = (value: string | undefined) =>
    value === undefined || blank(value) ? {} : { where: value.trim() }
  if (mode === 'review')
    return {
      mode,
      verdict: input.verdict === 'changes' ? 'changes' : 'nothing_to_change',
      findings: (input.findings ?? []).map((item) => ({
        kind: item.kind as 'missing' | 'contradiction' | 'uncheckable' | 'risk',
        ...where(item.where),
        text: item.text.trim(),
      })),
      unsure: t(input.unsure),
    }
  if (mode === 'restate')
    return {
      mode,
      changes: t(input.changes),
      requirements: t(input.requirements),
      left_out: t(input.left_out),
    }
  if (mode === 'recommend')
    return {
      mode,
      why_stopped: t(input.why_stopped),
      action: t(input.action),
      reasoning: t(input.reasoning),
      unsure: t(input.unsure),
    }
  if (mode === 'advise')
    return {
      mode,
      variant: t(input.variant) as ProposalOutcome,
      reasoning: t(input.reasoning),
      unsure: t(input.unsure),
    }
  return {
    mode,
    checked_against: input.checked_against as 'approved_spec' | 'latest_spec' | 'description',
    produced: t(input.produced),
    unfinished: (input.unfinished ?? []).map((item) => ({
      ...where(item.where),
      text: item.text.trim(),
    })),
    unsure: t(input.unsure),
  }
}
