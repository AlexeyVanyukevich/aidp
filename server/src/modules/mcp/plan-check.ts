import type { SpecCriterion } from '../../shared/vocabulary.js'

export interface PlanInput {
  summary: string
  confidence: 'high' | 'medium' | 'low'
  steps: { title: string; requirements: string[]; files: string[]; estimate_usd?: number }[]
  checks: { criterion: string; how: string }[]
  withdrawn?: Withdrawal[]
}

/** A criterion the owner withdrew at the plan gate, with the words that withdrew it. */
export interface Withdrawal {
  criterion: string
  answer: string
}

export interface ReportInput {
  summary: string
  criteria: { id: string; status: 'pass' | 'fail' | 'owner' | 'withdrawn'; evidence: string }[]
  withdrawn?: Withdrawal[]
}

export interface PlanFinding {
  code:
    | 'unknown_requirement'
    | 'criterion_without_check'
    | 'unknown_criterion'
    | 'unknown_withdrawn_criterion'
    | 'duplicate_withdrawn_criterion'
    | 'withdrawal_without_gate'
    | 'withdrawn_criterion_with_check'
    | 'withdrawn_answer_not_found'
  step?: number
  id: string
}

export interface ReportFinding {
  code:
    | 'missing_criterion'
    | 'unknown_criterion'
    | 'duplicate_criterion'
    | 'owner_on_unmarked_criterion'
    | 'pass_on_owner_check'
    | 'withdrawn_not_in_plan'
    | 'withdrawn_criterion_judged'
  id: string
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * `answers` are the owner's worded plan-gate answers on the run's spec version; a withdrawal's
 * words must be found in one of them, whitespace collapsed.
 */
export function checkPlan(
  plan: PlanInput,
  spec: { requirements: string[]; criteria: SpecCriterion[] },
  answers: string[] = [],
): PlanFinding[] {
  const findings: PlanFinding[] = []
  const requirements = new Set(spec.requirements)
  plan.steps.forEach((step, index) => {
    for (const id of step.requirements) {
      if (!requirements.has(id)) findings.push({ code: 'unknown_requirement', step: index + 1, id })
    }
  })
  const criteria = new Set(spec.criteria.map((c) => c.id))
  const checked = new Set(plan.checks.map((c) => c.criterion))
  const withdrawn = plan.withdrawn ?? []
  const withdrawnIds = new Set(withdrawn.map((w) => w.criterion))
  for (const id of criteria)
    if (!checked.has(id) && !withdrawnIds.has(id))
      findings.push({ code: 'criterion_without_check', id })
  for (const id of checked) if (!criteria.has(id)) findings.push({ code: 'unknown_criterion', id })
  const seen = new Set<string>()
  const said = answers.map(collapse)
  for (const { criterion, answer } of withdrawn) {
    if (!criteria.has(criterion))
      findings.push({ code: 'unknown_withdrawn_criterion', id: criterion })
    if (seen.has(criterion)) findings.push({ code: 'duplicate_withdrawn_criterion', id: criterion })
    seen.add(criterion)
    const quote = collapse(answer)
    if (quote === '' || !said.some((text) => text.includes(quote)))
      findings.push({ code: 'withdrawn_answer_not_found', id: criterion })
  }
  if (withdrawn.length > 0 && plan.confidence === 'high')
    findings.push({ code: 'withdrawal_without_gate', id: plan.confidence })
  for (const id of withdrawnIds)
    if (checked.has(id) && criteria.has(id))
      findings.push({ code: 'withdrawn_criterion_with_check', id })
  return findings
}

/** `withdrawnIds` are the criteria the run's accepted plan withdraws; none when it has no such plan. */
export function checkReport(
  report: ReportInput,
  criteria: SpecCriterion[],
  withdrawnIds: ReadonlySet<string> = new Set(),
): ReportFinding[] {
  const findings: ReportFinding[] = []
  const known = new Set(criteria.map((c) => c.id))
  const seen = new Set<string>()
  for (const verdict of report.criteria) {
    if (!known.has(verdict.id)) findings.push({ code: 'unknown_criterion', id: verdict.id })
    else if (seen.has(verdict.id)) findings.push({ code: 'duplicate_criterion', id: verdict.id })
    else {
      const marked = criteria.find((c) => c.id === verdict.id)?.owner === true
      if (verdict.status === 'owner' && !marked)
        findings.push({ code: 'owner_on_unmarked_criterion', id: verdict.id })
      if (verdict.status === 'pass' && marked)
        findings.push({ code: 'pass_on_owner_check', id: verdict.id })
      const isWithdrawn = withdrawnIds.has(verdict.id)
      if (verdict.status === 'withdrawn' && !isWithdrawn)
        findings.push({ code: 'withdrawn_not_in_plan', id: verdict.id })
      if (isWithdrawn && verdict.status !== 'withdrawn')
        findings.push({ code: 'withdrawn_criterion_judged', id: verdict.id })
    }
    seen.add(verdict.id)
  }
  for (const id of known) if (!seen.has(id)) findings.push({ code: 'missing_criterion', id })
  return findings
}

export function planFiles(plan: PlanInput): string[] {
  return [...new Set(plan.steps.flatMap((step) => step.files))].sort()
}

const oneLine = (text: string) => text.replace(/\r?\n/g, ' ')
const cell = (text: string) => oneLine(text).replaceAll('|', '\\|')
const withdrawnLines = (withdrawn: Withdrawal[]) =>
  withdrawn.map((w) => `- ${w.criterion} — ${oneLine(w.answer)}`)

export function renderPlan(plan: PlanInput): string {
  const steps = plan.steps.map((step, index) => {
    const files = step.files.map((f) => `\`${f}\``).join(', ')
    const estimate =
      step.estimate_usd === undefined ? '' : ` — est. $${step.estimate_usd.toFixed(2)}`
    return `${index + 1}. **${step.title}** (${step.requirements.join(', ')}) — ${files}${estimate}`
  })
  const withdrawn = plan.withdrawn ?? []
  const checks = plan.checks.map((check) => `| ${cell(check.criterion)} | ${cell(check.how)} |`)
  return [
    plan.summary,
    '',
    `Confidence: ${plan.confidence}`,
    '',
    ...steps,
    '',
    '| Criterion | Check |',
    '| --- | --- |',
    ...checks,
    ...(withdrawn.length === 0
      ? []
      : ['', 'Withdrawn by the owner:', ...withdrawnLines(withdrawn)]),
  ].join('\n')
}

const VERDICT_TEXT = {
  pass: '✔ pass',
  fail: '✘ fail',
  owner: '👁 owner',
  withdrawn: '⊘ withdrawn',
} as const

/** "1 criterion is yours to check: AC5.", or undefined when the report leaves none to the owner. */
export function ownerSentence(report: ReportInput): string | undefined {
  const ids = report.criteria.filter((c) => c.status === 'owner').map((c) => c.id)
  if (ids.length === 0) return undefined
  const head = ids.length === 1 ? '1 criterion is' : `${ids.length} criteria are`
  return `${head} yours to check: ${ids.join(', ')}.`
}

export function renderReport(report: ReportInput): string {
  const rows = report.criteria.map(
    (c) =>
      `| ${c.id} | ${VERDICT_TEXT[c.status]} | ${c.evidence.replaceAll('|', '\\|').replaceAll('\n', ' ')} |`,
  )
  const sentence = ownerSentence(report)
  const withdrawn = report.withdrawn ?? []
  return [
    report.summary,
    '',
    ...(sentence === undefined ? [] : [sentence, '']),
    ...(withdrawn.length === 0
      ? []
      : ['Withdrawn by the owner at the plan gate:', ...withdrawnLines(withdrawn), '']),
    '| Criterion | Verdict | Evidence |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n')
}
