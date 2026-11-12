import type { ProposalOutcome } from '../../shared/vocabulary.js'

export const TITLE_LIMIT = 200
export const DESCRIPTION_LIMIT = 100_000
export const BEARING_LIMIT = 2_000
export const WORKAROUND_LIMIT = 10_000
export const PROPOSAL_CAP = 10

export const LABELS = ['Where', 'Found', 'Problem', 'Impact'] as const

export const LABEL_FORM = LABELS.map((label) => `**${label}:** …`).join(', ')

/** The title trimmed, or the reason it is refused. */
export function checkTitle(raw: string): { title: string } | { error: string } {
  const title = raw.trim()
  if (title.length === 0)
    return { error: `title is empty; it must be 1–${TITLE_LIMIT} characters.` }
  if (title.length > TITLE_LIMIT)
    return { error: `title is ${title.length} characters; the limit is ${TITLE_LIMIT}.` }
  return { title }
}

/** The labels a description lacks. A label stands at a line start, after one optional list marker. */
export function missingLabels(description: string): string[] {
  return LABELS.filter((label) => {
    const pattern = new RegExp(`(^|\\n)(?:[-*+] )?\\*\\*${label}(?::\\*\\*|\\*\\*:)`)
    return !pattern.test(description)
  })
}

export function labelsError(missing: string[]): string {
  return `description_md lacks ${missing.join(', ')}. Write it as ${LABEL_FORM}, each at the start of a line.`
}

export const sameTitle = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

/** `Draft n` for a spec run, `Run n` for a delivery run. */
export const runLabel = (kind: string, number: number): string =>
  kind === 'spec' ? `Draft ${number}` : `Run ${number}`

export function proposedByLine(input: {
  taskKey: string
  kind: string
  runNumber: number
  phase: string
  outcome: 'file' | 'workaround'
}): string {
  const head = `Proposed by ${input.taskKey}, ${runLabel(input.kind, input.runNumber)}, ${input.phase}; filed by the owner`
  return input.outcome === 'workaround'
    ? `${head}, and ${input.taskKey} goes on with a workaround.`
    : `${head}.`
}

/** The filed task's description: the proposal's text, then the proposed-by line. */
export function filedDescription(description: string, line: string): string {
  return `${description.trimEnd()}\n\n${line}`
}

/** Characters the saved description will have, the proposed-by line included. */
export function descriptionLength(
  description: string,
  input: { taskKey: string; kind: string; runNumber: number; phase: string },
): number {
  // The longer form of the line is the bound, so a refused proposal can never overflow later.
  return filedDescription(description, proposedByLine({ ...input, outcome: 'workaround' })).length
}

/** The outcomes the owner may choose for an open proposal. `wait` is never offered yet. */
export function offeredVariants(input: {
  related: boolean
  hasWorkaround: boolean
  approval: 'open' | 'expired' | 'withdrawn' | 'answered' | null
}): ProposalOutcome[] {
  const live = input.approval === 'open' || input.approval === 'expired'
  if (input.related && live && input.hasWorkaround) return ['file', 'workaround', 'dismiss']
  return ['file', 'dismiss']
}

export const VARIANT_LABELS: Record<ProposalOutcome, string> = {
  file: 'File',
  workaround: 'Workaround and file',
  wait: 'Wait for it',
  dismiss: 'Dismiss',
}

export function resumeText(input: {
  outcome: 'file' | 'workaround' | 'dismiss'
  key: string | null
  title: string
  phase: string
  workaround: string | null
}): string {
  if (input.outcome === 'dismiss')
    return `The owner dismissed the proposal "${input.title}"; nothing was filed. Go on with the task unchanged.`
  if (input.outcome === 'file')
    return `The owner filed ${input.key}: ${input.title}. Go on with the task unchanged, and name ${input.key} in your summary.`
  return `The owner filed ${input.key}: ${input.title}, and chose your workaround. Carry it in the ${input.phase}, naming ${input.key}. The workaround: ${input.workaround ?? ''}`
}

export function proposedSummary(title: string): string {
  return `Proposed: ${title}`
}

export function settledSummary(
  outcome: ProposalOutcome,
  key: string | null,
  title: string,
): string {
  if (outcome === 'file') return `Filed ${key}: ${title}`
  if (outcome === 'workaround') return `Filed ${key} with the workaround: ${title}`
  return `Dismissed: ${title}`
}
