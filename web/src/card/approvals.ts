import type {
  ApprovalAnswer,
  ApprovalKind,
  ApprovalOption,
  ApprovalStatus,
  ApprovalView,
  BatchAnswer,
  BatchQuestion,
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
