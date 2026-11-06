import type {
  ApprovalAnswer,
  ApprovalKind,
  ApprovalOption,
  ApprovalStatus,
  ApprovalView,
  BatchAnswer,
  BatchQuestion,
  HelpMode,
  HelpResult,
  HelpView,
  TaskState,
} from '../types'

/** An option button's name: its label, and the recommendation in words (spec §11). */
export function optionName(option: ApprovalOption, recommendation: string | null): string {
  return option.id === recommendation ? `${option.label} (recommended)` : option.label
}

/** The one path of a migration request, or undefined for any other kind. */
export function migrationPath(approval: ApprovalView): string | undefined {
  return approval.kind === 'migration' ? approval.files?.[0] : undefined
}

/** The name of the code block: what a screen reader announces for the scrollable region. */
export const codeLabel = (path: string) => `Contents of ${path}`

export function headingFor(status: ApprovalStatus): string {
  return status === 'expired' ? 'Unanswered question' : 'Open question'
}

export function fieldLabel(kind: ApprovalKind): string {
  return kind === 'plan' ? 'Changes to ask for' : 'Your answer'
}

/** An answer in words: the chosen option's label, then what the owner wrote. */
function answerText(options: ApprovalOption[], answer: ApprovalAnswer | undefined): string {
  const chosen = options.find((o) => o.id === answer?.option_id)
  return [chosen?.label, answer?.text?.trim() || undefined]
    .filter((part) => part !== undefined)
    .join(' — ')
}

const single = (answer: ApprovalView['answer']): ApprovalAnswer | undefined =>
  answer === null || 'answers' in answer ? undefined : answer

/** What an answered request's line says it was answered with. */
export function answerSummary(approval: ApprovalView): string {
  if (approval.status === 'withdrawn') return 'Withdrawn: the run was cancelled.'
  return answerText(approval.options, single(approval.answer))
}

// A batch: several questions in one form, sent together (slice 3 spec, §11).

export function batchHeading(status: ApprovalStatus): string {
  return status === 'expired' ? 'Unanswered questions' : 'Open questions'
}

export const answerFieldLabel = (number: number) => `Your answer to question ${number}`

export const answerFieldHint = (hasOptions: boolean) =>
  hasOptions ? 'Optional when you choose an option.' : 'Write your answer.'

/** What the owner has chosen and written so far, by question id. */
export type Choices = Record<string, { option?: string; text: string }>

/** The indexes of the questions with neither an option nor words. */
export function unanswered(questions: BatchQuestion[], choices: Choices): number[] {
  return questions.flatMap((question, index) => {
    const choice = choices[question.id]
    return choice?.option !== undefined || (choice?.text.trim() ?? '') !== '' ? [] : [index]
  })
}

export function batchAnswer(questions: BatchQuestion[], choices: Choices): BatchAnswer {
  return {
    answers: questions.map((question) => {
      const choice = choices[question.id]
      const text = choice?.text.trim() ?? ''
      return {
        question_id: question.id,
        ...(choice?.option === undefined ? {} : { option_id: choice.option }),
        ...(text === '' ? {} : { text }),
      }
    }),
  }
}

/** An answered batch, question by question. */
export function batchAnswerLines(approval: ApprovalView): { question: string; answer: string }[] {
  const answers =
    approval.answer !== null && 'answers' in approval.answer ? approval.answer.answers : []
  return (approval.questions ?? []).map((question) => ({
    question: question.question,
    answer: answerText(
      question.options,
      answers.find((entry) => entry.question_id === question.id),
    ),
  }))
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

// Helps: a read-only helper's suggestion or plain explanation of a waiting question.

/** The state of one mode's help for one question. */
export interface ModeHelp {
  /** A help of this mode is queued or running: its button is busy and starts nothing more. */
  busy: boolean
  /** The latest succeeded help's result. */
  shown: HelpResult | undefined
  /** The reason the latest help failed, when it did. */
  failure: string | undefined
}
export interface QuestionHelp {
  suggest: ModeHelp
  explain: ModeHelp
}

/** The helps of one question: a single request's `index` is null. */
export function questionHelp(
  helps: HelpView[],
  approvalId: string,
  index: number | null,
): QuestionHelp {
  const of = (mode: HelpMode): ModeHelp => {
    const mine = helps
      .filter((h) => h.approval_id === approvalId && h.question_index === index && h.mode === mode)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    const latest = mine[0]
    return {
      busy: latest?.status === 'queued' || latest?.status === 'running',
      shown: mine.find((h) => h.status === 'succeeded')?.result ?? undefined,
      failure: latest?.status === 'failed' ? (latest.reason ?? 'the helper failed') : undefined,
    }
  }
  return { suggest: of('suggest'), explain: of('explain') }
}

export const failureText = (mode: HelpMode, reason: string) =>
  `${mode === 'suggest' ? 'No suggestion' : 'No explanation'}: ${reason}`

/** What the card's status region says of a help that ended. */
export function helpAnnouncement(help: HelpView, approval: ApprovalView | undefined): string {
  const label =
    approval?.kind === 'questions' && help.question_index !== null
      ? `question ${help.question_index + 1} of ${approval.question_count}`
      : 'the open question'
  if (help.status === 'failed')
    return `${help.mode === 'suggest' ? 'No suggestion' : 'No explanation'} for ${label}: ${help.reason ?? 'the helper failed'}`
  return help.mode === 'suggest'
    ? `Suggested answer ready for ${label}`
    : `Explanation ready for ${label}`
}

const IN_FLIGHT = new Set(['queued', 'running'])

/** The helps that ended since `seen`, which maps a help's id to the status it last had. */
export function newlyEnded(seen: Map<string, string>, helps: HelpView[]): HelpView[] {
  const ended = helps.filter(
    (h) =>
      (h.status === 'succeeded' || h.status === 'failed') && IN_FLIGHT.has(seen.get(h.id) ?? ''),
  )
  seen.clear()
  for (const h of helps) seen.set(h.id, h.status)
  return ended
}

/** A single request's choice, or one question's of a batch. */
export interface Choice {
  option?: string
  text: string
}

/** Use this answer: the suggested option when it has one, and the suggested words, replacing. */
export function applySuggestion(current: Choice, result: HelpResult): Choice {
  if (result.mode !== 'suggest') return current
  const option = result.option_id ?? current.option
  return {
    text: result.text ?? current.text,
    ...(option === undefined ? {} : { option }),
  }
}

/** What a single request sends: the chosen option, the words, or both; null with neither. */
export function singleAnswer(choice: Choice): ApprovalAnswer | null {
  const text = choice.text.trim()
  if (choice.option === undefined && text === '') return null
  return {
    ...(choice.option === undefined ? {} : { option_id: choice.option }),
    ...(text === '' ? {} : { text }),
  }
}
