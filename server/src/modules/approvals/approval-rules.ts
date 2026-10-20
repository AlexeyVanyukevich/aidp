import { isAbsolute } from 'node:path'
import type { ApprovalKind } from '../../shared/vocabulary.js'

/**
 * The rules of an approval request and its answer (slice 2 spec, §5): what a request may hold,
 * which options each kind offers, what an answer says to the agent it resumes, and which files
 * a run may change. Pure: no database, no clock.
 */

export interface ApprovalOption {
  id: string
  label: string
  impact?: string
}

export interface RequestInput {
  /** `plan` is the runner's own; an agent asks with `question` or `out_of_plan`. */
  kind: ApprovalKind
  question: string
  options: ApprovalOption[]
  recommendation?: string | null
  context_md?: string | null
  files?: string[] | null
}

export interface Answer {
  option_id?: string
  text?: string
}

export interface Finding {
  field: string
  code: 'required' | 'too_long' | 'too_many' | 'unknown_option' | 'duplicate' | 'not_relative'
}

export const LIMITS = {
  question: 1_000,
  label: 200,
  impact: 500,
  context: 8_000,
  options: 5,
  files: 20,
  answer: 4_000,
} as const

const FIXED: Partial<Record<ApprovalKind, ApprovalOption[]>> = {
  out_of_plan: [
    { id: 'allow', label: 'Allow the change' },
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

export function checkRequest(input: RequestInput): Finding[] {
  const findings: Finding[] = []
  if (blank(input.question)) findings.push({ field: 'question', code: 'required' })
  else if (input.question.length > LIMITS.question)
    findings.push({ field: 'question', code: 'too_long' })

  const options = optionsFor(input.kind, input.options)
  if (options.length > LIMITS.options) findings.push({ field: 'options', code: 'too_many' })
  const seen = new Set<string>()
  options.forEach((option, index) => {
    if (seen.has(option.id)) findings.push({ field: `options[${index}].id`, code: 'duplicate' })
    seen.add(option.id)
    if (blank(option.label)) findings.push({ field: `options[${index}].label`, code: 'required' })
    else if (option.label.length > LIMITS.label)
      findings.push({ field: `options[${index}].label`, code: 'too_long' })
    if (option.impact !== undefined && option.impact.length > LIMITS.impact)
      findings.push({ field: `options[${index}].impact`, code: 'too_long' })
  })
  if (
    input.recommendation !== undefined &&
    input.recommendation !== null &&
    !options.some((option) => option.id === input.recommendation)
  )
    findings.push({ field: 'recommendation', code: 'unknown_option' })

  if ((input.context_md ?? '').length > LIMITS.context)
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

const code = (files: string[]) => files.map((file) => `\`${file}\``).join(', ')
const withText = (lead: string, text: string | undefined) =>
  blank(text) ? lead : `${lead}\n\n${text?.trim()}`

/**
 * What the agent reads when its session resumes. `null` when the answer resumes no session:
 * an approved plan ends the Plan phase and Build starts afresh.
 */
export function resumeMessage(
  approval: { kind: ApprovalKind; options: ApprovalOption[]; files: string[] | null },
  answer: Answer,
): string | null {
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
    case 'question': {
      const picked =
        chosen === undefined
          ? undefined
          : chosen.impact
            ? `${chosen.label} — ${chosen.impact}`
            : chosen.label
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
    .filter((approval) => approval.kind === 'out_of_plan' && approval.answer.option_id === 'allow')
    .flatMap((approval) => approval.files ?? [])
  return [...new Set([...planFiles, ...allowed])]
}
