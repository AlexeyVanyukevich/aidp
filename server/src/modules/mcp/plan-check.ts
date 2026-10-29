import type { SpecCriterion } from '../../shared/vocabulary.js'

export interface PlanInput {
  summary: string
  confidence: 'high' | 'medium' | 'low'
  steps: { title: string; requirements: string[]; files: string[]; estimate_usd?: number }[]
  checks: { criterion: string; how: string }[]
}

export interface ReportInput {
  summary: string
  criteria: { id: string; status: 'pass' | 'fail' | 'owner'; evidence: string }[]
}

export interface PlanFinding {
  code: 'unknown_requirement' | 'criterion_without_check' | 'unknown_criterion'
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
  id: string
}

export function checkPlan(
  plan: PlanInput,
  spec: { requirements: string[]; criteria: SpecCriterion[] },
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
  for (const id of criteria)
    if (!checked.has(id)) findings.push({ code: 'criterion_without_check', id })
  for (const id of checked) if (!criteria.has(id)) findings.push({ code: 'unknown_criterion', id })
  return findings
}

export function checkReport(report: ReportInput, criteria: SpecCriterion[]): ReportFinding[] {
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
    }
    seen.add(verdict.id)
  }
  for (const id of known) if (!seen.has(id)) findings.push({ code: 'missing_criterion', id })
  return findings
}

export function planFiles(plan: PlanInput): string[] {
  return [...new Set(plan.steps.flatMap((step) => step.files))].sort()
}

export function renderPlan(plan: PlanInput): string {
  const steps = plan.steps.map((step, index) => {
    const files = step.files.map((f) => `\`${f}\``).join(', ')
    const estimate =
      step.estimate_usd === undefined ? '' : ` — est. $${step.estimate_usd.toFixed(2)}`
    return `${index + 1}. **${step.title}** (${step.requirements.join(', ')}) — ${files}${estimate}`
  })
  const checks = plan.checks.map((check) => `| ${check.criterion} | ${check.how} |`)
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
  ].join('\n')
}

const VERDICT_TEXT = { pass: '✔ pass', fail: '✘ fail', owner: '👁 owner' } as const

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
  return [
    report.summary,
    '',
    ...(sentence === undefined ? [] : [sentence, '']),
    '| Criterion | Verdict | Evidence |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n')
}
