import { isAbsolute } from 'node:path'
import type { ApprovalKind } from '../../shared/vocabulary.js'
import { migrationOrder } from './migration-order.js'

/**
 * The rules of an approval request and its answer (slice 2 spec, §5; a batch, slice 3 spec, §6):
 * what a request may hold, which options each kind offers, what an answer says to the agent it
 * resumes, and which files a run may change. Pure: no database, no clock.
 */

export interface ApprovalOption {
  id: string
  label: string
  impact?: string
}

export interface RequestInput {
  /** `plan` is the runner's own; an agent asks with `question`, `out_of_plan` or `questions`. */
  kind: ApprovalKind
  /** For a batch, its optional lead line. */
  question: string
  options: ApprovalOption[]
  recommendation?: string | null
  context_md?: string | null
  files?: string[] | null
  questions?: BatchQuestionInput[] | null
}

/** One question of a batch, as the agent asks it. */
export interface BatchQuestionInput {
  question: string
  options?: ApprovalOption[]
  recommendation?: string | null
  context_md?: string | null
}

/** One question of a batch, as the server keeps it: numbered, every field present. */
export interface BatchQuestion {
  id: string
  question: string
  options: ApprovalOption[]
  recommendation: string | null
  context_md: string | null
}

export interface Answer {
  option_id?: string
  text?: string
}

/** A batch is answered whole: one entry per question. */
export interface BatchAnswer {
  answers: (Answer & { question_id: string })[]
}

export interface Finding {
  field: string
  code:
    | 'required'
    | 'too_long'
    | 'too_many'
    | 'unknown_option'
    | 'unknown_question'
    | 'duplicate'
    | 'not_relative'
    | 'out_of_order'
  /** For `out_of_order`: the greatest sibling name, which a new name must sort after. */
  after?: string
}

/** What a migration request is checked against, read beforehand: the files beside the path. */
export interface MigrationSiblings {
  /** Whether the path exists in the run's worktree. */
  exists: boolean
  /** File names directly in the migration's directory, in the worktree and on the base. */
  siblings: string[]
}

export const LIMITS = {
  question: 1_000,
  label: 200,
  impact: 500,
  context: 8_000,
  migrationContext: 20_000,
  /** A plan approval's `context_md`, and the longest rendered plan `save_plan` accepts. */
  planContext: 20_000,
  questionContext: 2_000,
  options: 5,
  questions: 8,
  files: 20,
  answer: 4_000,
} as const

const FIXED: Partial<Record<ApprovalKind, ApprovalOption[]>> = {
  out_of_plan: [
    { id: 'allow', label: 'Allow the change' },
    { id: 'refuse', label: 'Keep to the plan' },
  ],
  migration: [
    { id: 'allow', label: 'Allow the migration' },
    { id: 'refuse', label: 'Keep to the plan' },
  ],
  plan: [{ id: 'approve', label: 'Approve plan' }],
}

/** The options a request offers: the agent's for a question, the server's for the rest. */
export function optionsFor(kind: ApprovalKind, agentOptions: ApprovalOption[]): ApprovalOption[] {
  return FIXED[kind] ?? agentOptions
}

const blank = (text: string | undefined | null) =>
  text === undefined || text === null || text.trim() === ''

/** A path inside the worktree: relative, and never climbing out of it. */
const insideWorktree = (path: string) =>
  path.trim() !== '' && !isAbsolute(path) && !path.split(/[\\/]/).includes('..')

/** A question's options and recommendation, the fields named under `prefix`. */
function checkOptions(
  prefix: string,
  options: ApprovalOption[],
  recommendation: string | null | undefined,
): Finding[] {
  const findings: Finding[] = []
  if (options.length > LIMITS.options)
    findings.push({ field: `${prefix}options`, code: 'too_many' })
  const seen = new Set<string>()
  options.forEach((option, index) => {
    const field = `${prefix}options[${index}]`
    if (seen.has(option.id)) findings.push({ field: `${field}.id`, code: 'duplicate' })
    seen.add(option.id)
    if (blank(option.label)) findings.push({ field: `${field}.label`, code: 'required' })
    else if (option.label.length > LIMITS.label)
      findings.push({ field: `${field}.label`, code: 'too_long' })
    if (option.impact !== undefined && option.impact.length > LIMITS.impact)
      findings.push({ field: `${field}.impact`, code: 'too_long' })
  })
  if (
    recommendation !== undefined &&
    recommendation !== null &&
    !options.some((option) => option.id === recommendation)
  )
    findings.push({ field: `${prefix}recommendation`, code: 'unknown_option' })
  return findings
}

function checkBatch(input: RequestInput): Finding[] {
  const findings: Finding[] = []
  if (input.question.length > LIMITS.question)
    findings.push({ field: 'question', code: 'too_long' })
  const questions = input.questions ?? []
  if (questions.length === 0) findings.push({ field: 'questions', code: 'required' })
  else if (questions.length > LIMITS.questions)
    findings.push({ field: 'questions', code: 'too_many' })
  questions.forEach((question, index) => {
    const prefix = `questions[${index}].`
    if (blank(question.question)) findings.push({ field: `${prefix}question`, code: 'required' })
    else if (question.question.length > LIMITS.question)
      findings.push({ field: `${prefix}question`, code: 'too_long' })
    findings.push(...checkOptions(prefix, question.options ?? [], question.recommendation))
    if ((question.context_md ?? '').length > LIMITS.questionContext)
      findings.push({ field: `${prefix}context_md`, code: 'too_long' })
  })
  if ((input.context_md ?? '').length > LIMITS.context)
    findings.push({ field: 'context_md', code: 'too_long' })
  return findings
}

export function checkRequest(input: RequestInput, order?: MigrationSiblings): Finding[] {
  if (input.kind === 'questions') return checkBatch(input)
  const findings: Finding[] = []
  if (blank(input.question)) findings.push({ field: 'question', code: 'required' })
  else if (input.question.length > LIMITS.question)
    findings.push({ field: 'question', code: 'too_long' })

  findings.push(...checkOptions('', optionsFor(input.kind, input.options), input.recommendation))

  if (input.kind === 'migration') {
    if (blank(input.context_md)) findings.push({ field: 'context_md', code: 'required' })
    else if ((input.context_md ?? '').length > LIMITS.migrationContext)
      findings.push({ field: 'context_md', code: 'too_long' })
    const files = input.files ?? []
    if (files.length === 0) findings.push({ field: 'files', code: 'required' })
    else if (files.length > 1) findings.push({ field: 'files', code: 'too_many' })
    else if (!insideWorktree(files[0] ?? ''))
      findings.push({ field: 'files[0]', code: 'not_relative' })
    else if (order !== undefined && !order.exists) {
      const { tooEarly, after } = migrationOrder(
        (files[0] ?? '').split(/[\\/]/).at(-1) ?? '',
        order.siblings,
      )
      if (tooEarly && after !== null)
        findings.push({ field: 'files[0]', code: 'out_of_order', after })
    }
  } else if (
    (input.context_md ?? '').length > (input.kind === 'plan' ? LIMITS.planContext : LIMITS.context)
  )
    findings.push({ field: 'context_md', code: 'too_long' })

  if (input.kind === 'out_of_plan') {
    const files = input.files ?? []
    if (files.length === 0) findings.push({ field: 'files', code: 'required' })
    else if (files.length > LIMITS.files) findings.push({ field: 'files', code: 'too_many' })
    else
      files.forEach((file, index) => {
        if (!insideWorktree(file)) findings.push({ field: `files[${index}]`, code: 'not_relative' })
      })
  }
  return findings
}

export function checkAnswer(approval: { options: ApprovalOption[] }, answer: Answer): Finding[] {
  const findings: Finding[] = []
  if (answer.option_id === undefined && blank(answer.text))
    findings.push({ field: 'text', code: 'required' })
  if (
    answer.option_id !== undefined &&
    !approval.options.some((option) => option.id === answer.option_id)
  )
    findings.push({ field: 'option_id', code: 'unknown_option' })
  if ((answer.text ?? '').length > LIMITS.answer) findings.push({ field: 'text', code: 'too_long' })
  return findings
}

/** A batch as the server keeps it: `q1` … `qn`, in the order the agent asked. */
export function numberQuestions(questions: BatchQuestionInput[]): BatchQuestion[] {
  return questions.map((question, index) => ({
    id: `q${index + 1}`,
    question: question.question.trim(),
    options: question.options ?? [],
    recommendation: question.recommendation ?? null,
    context_md: question.context_md ?? null,
  }))
}

/** The lead line of a batch the agent gave none. */
export function leadLine(count: number): string {
  return count === 1 ? '1 question about the spec' : `${count} questions about the spec`
}

/** Every question answered, by an option it offers, by words, or both (slice 3 spec, §6). */
export function checkBatchAnswer(questions: BatchQuestion[], answer: BatchAnswer): Finding[] {
  const findings: Finding[] = []
  const known = new Set(questions.map((question) => question.id))
  const ids = answer.answers.map((entry) => entry.question_id)
  if (ids.some((id) => !known.has(id)))
    findings.push({ field: 'answers', code: 'unknown_question' })
  if (new Set(ids).size !== ids.length) findings.push({ field: 'answers', code: 'duplicate' })
  questions.forEach((question, index) => {
    const field = `answers[${index}]`
    const entry = answer.answers.find((candidate) => candidate.question_id === question.id)
    if (entry === undefined || (entry.option_id === undefined && blank(entry.text))) {
      findings.push({ field, code: 'required' })
      return
    }
    if (
      entry.option_id !== undefined &&
      !question.options.some((option) => option.id === entry.option_id)
    )
      findings.push({ field: `${field}.option_id`, code: 'unknown_option' })
    if ((entry.text ?? '').length > LIMITS.answer)
      findings.push({ field: `${field}.text`, code: 'too_long' })
  })
  return findings
}

/** How many questions an approval holds: a batch's count, else one. */
export function questionCount(approval: {
  kind: ApprovalKind
  questions: BatchQuestion[] | null
}): number {
  return approval.kind === 'questions' ? (approval.questions ?? []).length : 1
}

const chosenText = (option: ApprovalOption | undefined) =>
  option === undefined
    ? undefined
    : option.impact
      ? `${option.label} — ${option.impact}`
      : option.label

const indent = (text: string) =>
  text
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n')

function batchMessage(questions: BatchQuestion[], answer: BatchAnswer): string {
  const items = questions.map((question, index) => {
    const entry = answer.answers.find((candidate) => candidate.question_id === question.id)
    const chosen = chosenText(question.options.find((option) => option.id === entry?.option_id))
    const parts = [chosen, blank(entry?.text) ? undefined : entry?.text?.trim()].filter(
      (part) => part !== undefined,
    )
    return [`${index + 1}. ${question.question}`, ...parts.map(indent)].join('\n')
  })
  return ['The owner answered your questions:', ...items].join('\n\n')
}

const code = (files: string[]) => files.map((file) => `\`${file}\``).join(', ')
const withText = (lead: string, text: string | undefined) =>
  blank(text) ? lead : `${lead}\n\n${text?.trim()}`

/**
 * What the agent reads when its session resumes. `null` when the answer resumes no session:
 * an approved plan ends the Plan phase and Build starts afresh.
 */
export function resumeMessage(
  approval: {
    kind: ApprovalKind
    options: ApprovalOption[]
    files: string[] | null
    questions?: BatchQuestion[] | null
  },
  answer: Answer | BatchAnswer,
): string | null {
  if ('answers' in answer) return batchMessage(approval.questions ?? [], answer)
  const chosen = approval.options.find((option) => option.id === answer.option_id)
  const files = approval.files ?? []
  switch (approval.kind) {
    case 'plan':
      if (chosen?.id === 'approve') return null
      return `The owner asked for changes to the plan:\n\n${answer.text?.trim() ?? ''}\n\nSave the revised plan with save_plan.`
    case 'out_of_plan':
      if (chosen?.id === 'allow')
        return withText(`The owner allowed changes to: ${code(files)}.`, answer.text)
      if (chosen?.id === 'refuse')
        return withText(`The owner kept to the plan. Do not change: ${code(files)}.`, answer.text)
      return withText(`The owner answered your request to change ${code(files)}:`, answer.text)
    case 'migration':
      if (chosen?.id === 'allow')
        return withText(`The owner allowed the migration ${code(files)}.`, answer.text)
      if (chosen?.id === 'refuse')
        return withText(
          `The owner kept to the plan. Do not create or change ${code(files)}. Finish without it, and say in your report that the migration is needed.`,
          answer.text,
        )
      return withText(
        `The owner answered your request for the migration ${code(files)}:`,
        answer.text,
      )
    case 'questions':
      // A batch answered without its answers: say so, rather than resume with nothing.
      return batchMessage(approval.questions ?? [], { answers: [] })
    case 'question': {
      const picked = chosenText(chosen)
      const body = [picked, blank(answer.text) ? undefined : answer.text?.trim()]
        .filter((part) => part !== undefined)
        .join('\n\n')
      return `The owner answered your question:\n\n${body}`
    }
  }
}

/** The plan's files, then every file an answered out-of-plan request allowed, each once. */
export function allowedFiles(
  planFiles: string[],
  answered: { kind: ApprovalKind; files: string[] | null; answer: Answer }[],
): string[] {
  const allowed = answered
    .filter(
      (approval) =>
        (approval.kind === 'out_of_plan' || approval.kind === 'migration') &&
        approval.answer.option_id === 'allow',
    )
    .flatMap((approval) => approval.files ?? [])
  return [...new Set([...planFiles, ...allowed])]
}

/** Paths of migrations the owner allowed: the guard lets these through for the rest of the run. */
export function approvedMigrations(
  answered: { kind: ApprovalKind; files: string[] | null; answer: Answer }[],
): string[] {
  return [
    ...new Set(
      answered
        .filter(
          (approval) => approval.kind === 'migration' && approval.answer.option_id === 'allow',
        )
        .flatMap((approval) => approval.files ?? []),
    ),
  ]
}
