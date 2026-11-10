import type {
  ApprovalAnswer,
  ApprovalKind,
  ApprovalOption,
  ApprovalStatus,
  ApprovalView,
  BatchAnswer,
  BatchQuestion,
  HelpDecision,
  HelpMode,
  HelpResult,
  HelpSubject,
  HelpView,
  QuestionHelpMode,
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
  /** The subject of the help that is shown, or else of the latest one: a decision help's version. */
  subject?: HelpSubject | null
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
  const of = (mode: QuestionHelpMode): ModeHelp => {
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

export const failureText = (mode: QuestionHelpMode, reason: string) =>
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

// Decision helps: advice on a decision of the card, beside the question helps above.

/** The helps of one decision, by mode: busy while one is in flight, the result and the failure. */
export function decisionHelp(
  helps: HelpView[],
  decision: Exclude<HelpDecision, 'question'>,
): Partial<Record<HelpMode, ModeHelp>> {
  return Object.fromEntries(
    (['review', 'restate', 'recommend', 'check'] as const).map((mode) => {
      const mine = helps
        .filter((h) => h.decision === decision && h.mode === mode)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
      const latest = mine[0]
      const done = mine.find((h) => h.status === 'succeeded')
      const state: ModeHelp = {
        busy: latest?.status === 'queued' || latest?.status === 'running',
        shown: done?.result ?? undefined,
        failure: latest?.status === 'failed' ? (latest.reason ?? 'the helper failed') : undefined,
        subject: (latest?.status === 'failed' ? latest : (done ?? latest))?.subject ?? null,
      }
      return [mode, state] as const
    }),
  )
}

/** The mode state of one mode, empty when nothing was asked. */
export const NO_HELP: ModeHelp = { busy: false, shown: undefined, failure: undefined }

/** The words a decision help's result is shown under. */
export function resultHeading(mode: HelpMode, subject: HelpSubject | null): string {
  const version = `v${subject?.spec_version ?? '?'}`
  if (mode === 'review') return `Spec review of ${version}`
  if (mode === 'restate') return `${version} in plain words`
  if (mode === 'recommend') return 'Suggested next step'
  return 'What is unfinished'
}

/** A failed decision help's sentence, without the final full stop. */
export function decisionFailure(mode: HelpMode, subject: HelpSubject | null, reason: string) {
  const version = `v${subject?.spec_version ?? '?'}`
  if (mode === 'review') return `No spec review for ${version}: ${reason}`
  if (mode === 'restate') return `No plain-words spec for ${version}: ${reason}`
  if (mode === 'recommend') return `No suggested next step for the stopped run: ${reason}`
  return `No unfinished-work check for Mark done: ${reason}`
}

/** What the card's status region says of a decision help that ended; null for a stopped one. */
export function decisionAnnouncement(help: HelpView): string | null {
  if (help.status === 'failed')
    return `${decisionFailure(help.mode, help.subject, help.reason ?? 'the helper failed')}.`
  if (help.status !== 'succeeded') return null
  const version = `v${help.subject?.spec_version ?? '?'}`
  if (help.mode === 'review') return `Spec review ready for ${version}.`
  if (help.mode === 'restate') return `Plain-words spec ready for ${version}.`
  if (help.mode === 'recommend') return 'Suggested next step ready for the stopped run.'
  return 'Unfinished-work check ready for Mark done.'
}

/**
 * The sentences for results or failure lines that were shown and are gone while the card's state
 * stayed the same: "<heading> no longer applies." A move is covered by the state announcement.
 */
export function goneResults(
  before: HelpView[],
  after: HelpView[],
  stateChanged: boolean,
): string[] {
  if (stateChanged) return []
  const kept = new Set(after.map((h) => h.id))
  return before
    .filter(
      (h) =>
        h.decision !== 'question' &&
        (h.status === 'succeeded' || h.status === 'failed') &&
        !kept.has(h.id),
    )
    .map((h) => `${resultHeading(h.mode, h.subject)} no longer applies.`)
}
