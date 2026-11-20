import { ApiError } from '../api'
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
  /** The id of the help whose result is shown: another id is another result. */
  id?: string
  /** Where a shown suggestion came from: the question's own help, or the whole batch's. */
  source?: 'own' | 'whole'
}
export interface QuestionHelp {
  suggest: ModeHelp
  explain: ModeHelp
  /** Review plan: only a plan request offers it. */
  review_plan: ModeHelp
}

type Suggestion = Extract<HelpResult, { mode: 'suggest' }>

const inFlight = (help: HelpView | undefined) =>
  help?.status === 'queued' || help?.status === 'running'

const newest = (a: HelpView, b: HelpView) => b.created_at.localeCompare(a.created_at)

/** The heading a suggestion sits under, by where it came from. */
export const suggestHeading = (source: 'own' | 'whole') =>
  source === 'whole' ? 'Suggested with the whole batch' : 'Suggested answer'

/** The helps of one question: a single request's `index` is null. */
export function questionHelp(
  helps: HelpView[],
  approvalId: string,
  index: number | null,
  questionId?: string,
): QuestionHelp {
  const mineOf = (mode: QuestionHelpMode, at: number | null) =>
    helps
      .filter((h) => h.approval_id === approvalId && h.question_index === at && h.mode === mode)
      .sort(newest)
  const of = (mode: QuestionHelpMode): ModeHelp => {
    const mine = mineOf(mode, index)
    const latest = mine[0]
    return {
      busy: inFlight(latest),
      shown: mine.find((h) => h.status === 'succeeded')?.result ?? undefined,
      failure: latest?.status === 'failed' ? (latest.reason ?? 'the helper failed') : undefined,
      ...(mine.find((h) => h.status === 'succeeded') === undefined
        ? {}
        : { id: (mine.find((h) => h.status === 'succeeded') as HelpView).id }),
    }
  }
  const explain = of('explain')
  const review_plan = { ...of('review_plan'), subject: null }
  const ownHelps = mineOf('suggest', index)
  if (index === null || questionId === undefined)
    return { suggest: of('suggest'), explain, review_plan }

  // A batch question: its own suggestion, and its answer in the whole batch's, the newer shown.
  const wholeHelps = mineOf('suggest_all', null)
  const ownDone = ownHelps.find((h) => h.status === 'succeeded')
  const wholeDone = wholeHelps.find(
    (h) =>
      h.status === 'succeeded' &&
      h.result?.mode === 'suggest_all' &&
      h.result.answers.some((a) => a.question_id === questionId),
  )
  const wholeAnswer =
    wholeDone?.result?.mode === 'suggest_all'
      ? wholeDone.result.answers.find((a) => a.question_id === questionId)
      : undefined
  const useWhole =
    wholeDone !== undefined &&
    wholeAnswer !== undefined &&
    (ownDone === undefined || wholeDone.created_at.localeCompare(ownDone.created_at) > 0)
  const shown: Suggestion | undefined =
    useWhole && wholeAnswer !== undefined
      ? {
          mode: 'suggest',
          ...(wholeAnswer.option_id === undefined ? {} : { option_id: wholeAnswer.option_id }),
          ...(wholeAnswer.text === undefined ? {} : { text: wholeAnswer.text }),
          reasoning: wholeAnswer.reasoning,
          unsure: wholeAnswer.unsure,
        }
      : ((ownDone?.result as Suggestion | null | undefined) ?? undefined)
  const shownId = useWhole ? wholeDone?.id : ownDone?.id
  const latest = [...ownHelps.slice(0, 1), ...wholeHelps.slice(0, 1)].sort(newest)[0]
  return {
    suggest: {
      busy: inFlight(ownHelps[0]) || inFlight(wholeHelps[0]),
      shown,
      failure: latest?.status === 'failed' ? (latest.reason ?? 'the helper failed') : undefined,
      ...(shown === undefined
        ? {}
        : {
            source: useWhole ? ('whole' as const) : ('own' as const),
            ...(shownId === undefined ? {} : { id: shownId }),
          }),
    },
    explain,
    review_plan,
  }
}

/** Whether the request has a whole-batch suggestion to use: Use every answer is shown then. */
export function hasWholeAnswers(helps: HelpView[], approvalId: string): boolean {
  return helps.some(
    (h) =>
      h.approval_id === approvalId &&
      h.mode === 'suggest_all' &&
      h.status === 'succeeded' &&
      h.result?.mode === 'suggest_all',
  )
}

/** The words of a Use every answer press. */
export function fillMessage(filled: number, skipped: number): string {
  return filled === 0
    ? 'Every question is already answered; nothing was filled.'
    : `Filled ${filled} ${filled === 1 ? 'answer' : 'answers'}; skipped ${skipped} already answered.`
}

/**
 * Use every answer: each question with neither an option nor words takes the suggestion shown
 * under it, as its own Use this answer would; every other question stays as it is.
 */
export function fillEveryAnswer(
  questions: BatchQuestion[],
  choices: Choices,
  shownFor: (question: BatchQuestion, index: number) => Suggestion | undefined,
): { choices: Choices; filled: string[]; message: string } {
  const open = unanswered(questions, choices)
  const next: Choices = { ...choices }
  const filled: string[] = []
  for (const index of open) {
    const question = questions[index]
    const suggestion = question === undefined ? undefined : shownFor(question, index)
    if (question === undefined || suggestion === undefined) continue
    next[question.id] = applySuggestion(
      'question',
      choices[question.id] ?? { text: '' },
      suggestion,
    )
    filled.push(question.id)
  }
  return {
    choices: next,
    filled,
    message: fillMessage(filled.length, questions.length - open.length),
  }
}

export const failureText = (mode: QuestionHelpMode, reason: string) =>
  `${mode === 'explain' ? 'No explanation' : 'No suggestion'}: ${reason}`

/** What the card's status region says of a help that ended. */
export function helpAnnouncement(help: HelpView, approval: ApprovalView | undefined): string {
  const label =
    approval?.kind === 'questions' && help.question_index !== null
      ? `question ${help.question_index + 1} of ${approval.question_count}`
      : 'the open question'
  if (help.mode === 'suggest_all')
    return help.status === 'failed'
      ? `No suggestions for the batch: ${help.reason ?? 'the helper failed'}`
      : `Suggested answers ready for all ${approval?.question_count ?? (help.result?.mode === 'suggest_all' ? help.result.answers.length : 0)} questions`
  if (help.mode === 'review_plan')
    return help.status === 'failed'
      ? `No plan review: ${help.reason ?? 'the helper failed'}.`
      : 'Plan review ready.'
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

export const NO_WORDS_WITH_PLAN =
  'Approving the plan carries no words. Clear them, or press Clear choice to ask for changes.'
export const ANSWER_TOO_LONG = 'The answer is longer than 4,000 characters.'

/** The words-field message for an answer the board refused, or undefined for any other failure. */
export function answerRefusal(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.code !== 'validation_error') return undefined
  const details = error.details
  if (details?.field === 'text') {
    const findings = details.findings
    const first = Array.isArray(findings)
      ? (findings[0] as { code?: unknown } | undefined)
      : undefined
    if (first?.code === 'not_allowed') return NO_WORDS_WITH_PLAN
    if (first?.code === 'too_long') return ANSWER_TOO_LONG
    return undefined
  }
  const issues = details?.issues
  const issue = Array.isArray(issues)
    ? (issues[0] as { instancePath?: unknown; keyword?: unknown } | undefined)
    : undefined
  return issue?.instancePath === '/text' && issue.keyword === 'maxLength'
    ? ANSWER_TOO_LONG
    : undefined
}

/**
 * Use this answer: the suggested option when it has one, and the suggested words, replacing.
 * At a plan gate an approve suggestion chooses Approve plan and empties the words field: an
 * approval carries no words, so the suggested notes are shown as not sent and never reach the
 * run. Words with no option fill the words and clear any chosen option.
 */
export function applySuggestion(kind: ApprovalKind, current: Choice, result: HelpResult): Choice {
  if (result.mode !== 'suggest') return current
  if (kind === 'plan') {
    if (result.option_id === 'approve') return { option: 'approve', text: '' }
    if (result.text !== undefined && result.text.trim() !== '') return { text: result.text }
    const option = result.option_id ?? current.option
    return {
      text: current.text,
      ...(option === undefined ? {} : { option }),
    }
  }
  const option = result.option_id ?? current.option
  return {
    text: result.text ?? current.text,
    ...(option === undefined ? {} : { option }),
  }
}

/** What the status region says when Use this answer chooses Approve plan; none otherwise. */
export function suggestionMessage(
  kind: ApprovalKind,
  current: Choice,
  result: HelpResult,
): string | undefined {
  if (kind !== 'plan' || result.mode !== 'suggest' || result.option_id !== 'approve')
    return undefined
  if (result.text !== undefined && result.text.trim() !== '')
    return 'Approve plan chosen. An approval carries no words: the suggested words are not sent, and the words field is empty.'
  if (current.text.trim() !== '')
    return 'Approve plan chosen. An approval carries no words: the words field is empty.'
  return 'Approve plan chosen.'
}

export type ReviewResult = Extract<HelpResult, { mode: 'review' }>
export type PlanReviewResult = Extract<HelpResult, { mode: 'review_plan' }>
export type PrReviewResult = Extract<HelpResult, { mode: 'code_review' }>
/** A review of the spec or of the plan: the two whose findings can go into the owner's words. */
export type GateReviewResult = ReviewResult | PlanReviewResult

/** What the owner picked for one finding: its text as written, leaving it out, or a choice. */
export type FindingPick = 'written' | 'out' | number

/** The choices of a finding as one sentence, the recommended one marked, "or" before the last. */
function choicesText(choices: string[], recommended: number | undefined): string {
  const marked = choices.map((choice, index) =>
    index === recommended ? `${choice} (recommended)` : choice,
  )
  return marked.length < 2
    ? marked.join('')
    : `${marked.slice(0, -1).join('; ')}; or ${marked[marked.length - 1]}`
}

/** The choices of a finding for the list on the card, joined with "; ". */
export function choicesLabel(choices: string[], recommended: number | undefined): string {
  return choices
    .map((choice, index) => (index === recommended ? `${choice} (recommended)` : choice))
    .join('; ')
}

const DESTINATION_WORDS = {
  blocker: 'blocker',
  next_gate: 'next gate',
  outside: 'outside',
} as const

/**
 * The words after Use these findings: one line per blocker and next-gate finding that is not left
 * out, with the owner's decision or an open-choice marker under it, added after a blank line to
 * words already there. Outside findings, Unsure about and the verdict stay out. A missing pick is
 * "Use as written". When nothing is left to write the words are returned as they were.
 */
export function fillNoteFromReview(
  note: string,
  result: GateReviewResult,
  picks: readonly FindingPick[] = [],
): string {
  const lines = result.findings.flatMap((finding, index) => {
    if (finding.destination === 'outside') return []
    const pick = picks[index] ?? 'written'
    if (pick === 'out') return []
    const line = `- ${DESTINATION_WORDS[finding.destination]}, ${finding.kind}${finding.where === undefined ? '' : ` (${finding.where})`}: ${finding.text}`
    const choices = finding.choices ?? []
    if (typeof pick === 'number' && choices[pick] !== undefined)
      return [`${line}\n  Decision: ${choices[pick]}`]
    if (choices.length > 0)
      return [`${line}\n  Open choice, ask me: ${choicesText(choices, finding.recommended)}`]
    return [line]
  })
  if (lines.length === 0) return note
  const words = note.trimEnd()
  return words === '' ? lines.join('\n') : `${words}\n\n${lines.join('\n')}`
}

/** The announcements of Use these findings at the spec gate, where the words go to the planner. */
const APPROVAL_NOTE_FILLED = 'Findings put in Note for the planner.'
const APPROVAL_NOTE_UNCHANGED = 'Every finding is left out; Note for the planner is unchanged.'

/** The approval note after Use these findings, and what to announce; nothing is sent. */
export function fillApprovalNote(
  note: string,
  result: GateReviewResult,
  picks: readonly FindingPick[] = [],
): { note: string; message: string } {
  const next = fillNoteFromReview(note, result, picks)
  return { note: next, message: next === note ? APPROVAL_NOTE_UNCHANGED : APPROVAL_NOTE_FILLED }
}

/** What the owner chose for a finding of the pull request review: put it in the note, or not. */
export type RerunPick = 'in' | 'out'

/** Blockers start at Put in the note, and outside findings at Leave out. */
export function defaultRerunPicks(result: PrReviewResult): RerunPick[] {
  return result.findings.map((finding) => (finding.destination === 'blocker' ? 'in' : 'out'))
}

/** The date and time of a stored timestamp as `2026-11-17 10:30`, in UTC. */
const dateTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`

/**
 * The Re-run note after Fill note: the chosen findings of the pull request review, each with its
 * evidence, after any words already there. Nothing chosen leaves the note as it was.
 */
export function fillRerunNote(
  note: string,
  result: PrReviewResult,
  createdAt: string,
  picks: readonly RerunPick[],
): string {
  const lines = result.findings.flatMap((finding, index) =>
    (picks[index] ?? 'out') === 'out'
      ? []
      : [
          `- ${DESTINATION_WORDS[finding.destination]}, ${finding.kind} (${finding.where}): ${finding.text} Evidence: ${finding.evidence}`,
        ],
  )
  if (lines.length === 0) return note
  const commit = result.commit === null ? 'unknown' : result.commit.slice(0, 12)
  const block = `From the pull request review of ${dateTime(createdAt)}, at commit ${commit}:\n${lines.join('\n')}`
  const words = note.trimEnd()
  return words === '' ? block : `${words}\n\n${block}`
}

/** A refusal the form can give before sending: an approval carries no words. */
export function preSendProblem(kind: ApprovalKind, choice: Choice): string | undefined {
  return kind === 'plan' && choice.option === 'approve' && choice.text.trim() !== ''
    ? NO_WORDS_WITH_PLAN
    : undefined
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
    (['review', 'restate', 'recommend', 'check', 'code_review'] as const).map((mode) => {
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
        ...(done === undefined ? {} : { id: done.id }),
      }
      return [mode, state] as const
    }),
  )
}

/** The mode state of one mode, empty when nothing was asked. */
export const NO_HELP: ModeHelp = { busy: false, shown: undefined, failure: undefined }

/** The words a decision help's result is shown under. */
export function resultHeading(
  mode: HelpMode,
  subject: HelpSubject | null,
  result?: HelpResult,
): string {
  if (mode === 'code_review') {
    const commit = result?.mode === 'code_review' ? result.commit : null
    return commit === null || commit === undefined
      ? 'Pull request review'
      : `Pull request review of ${commit.slice(0, 7)}`
  }
  const version = `v${subject?.spec_version ?? '?'}`
  if (mode === 'review_plan') return 'Plan review'
  if (mode === 'review') return `Spec review of ${version}`
  if (mode === 'restate') return `${version} in plain words`
  if (mode === 'recommend') return 'Suggested next step'
  return 'What is unfinished'
}

/** A failed decision help's sentence, without the final full stop. */
export function decisionFailure(mode: HelpMode, subject: HelpSubject | null, reason: string) {
  if (mode === 'code_review') return `No pull request review: ${reason}`
  if (mode === 'review_plan') return `No plan review: ${reason}`
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
  if (help.mode === 'code_review') {
    const commit = help.result?.mode === 'code_review' ? help.result.commit : null
    return commit === null || commit === undefined
      ? 'Pull request review ready.'
      : `Pull request review ready for ${commit.slice(0, 7)}.`
  }
  if (help.mode === 'review_plan') return 'Plan review ready.'
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
    .map((h) => `${resultHeading(h.mode, h.subject, h.result ?? undefined)} no longer applies.`)
}
