import type { SpecCriterion } from '../../shared/vocabulary.js'

export type LintCode =
  | 'no_requirements'
  | 'requirement_without_id'
  | 'criterion_without_id'
  | 'criterion_without_requirement'
  | 'requirement_without_criterion'
  | 'unknown_requirement'
  | 'duplicate_id'

export interface LintFinding {
  code: LintCode
  id?: string
  text?: string
}

export interface ParsedSpec {
  requirements: { id: string; text: string }[]
  criteria: SpecCriterion[]
  openQuestions: string[]
  findings: LintFinding[]
  /** The lint passes and no open question remains. */
  approvable: boolean
}

const HEADING = /^##\s+(.+?)\s*#*\s*$/
// A list item at the start of a line: `1.`, `1)`, `-`, `*` or `+`. Indented continuation lines
// are not items and are ignored.
const ITEM = /^(?:\d+[.)]|[-*+])\s+(.*)$/
const REQUIREMENT = /^(R\d+)\b\s*[–—:.)-]?\s*(.*)$/
const CRITERION = /^(AC\d+)\s*\(([^)]*)\)\s*[:.–—-]?\s*(.*)$/

/** The list items under each `## heading`, keyed by the heading in lower case. */
function sections(markdown: string): Map<string, string[]> {
  const result = new Map<string, string[]>()
  let current: string[] | undefined
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const heading = HEADING.exec(line)
    if (heading?.[1] !== undefined) {
      current = []
      result.set(heading[1].toLowerCase(), current)
      continue
    }
    if (current === undefined) continue
    const item = ITEM.exec(line)
    if (item?.[1] !== undefined) current.push(item[1].trim())
  }
  return result
}

export function parseSpec(markdown: string): ParsedSpec {
  const found = sections(markdown)
  const findings: LintFinding[] = []
  const seen = new Set<string>()
  const noteId = (id: string) => {
    if (seen.has(id)) findings.push({ code: 'duplicate_id', id })
    seen.add(id)
  }

  const requirements: { id: string; text: string }[] = []
  const requirementItems = found.get('requirements') ?? []
  if (requirementItems.length === 0) findings.push({ code: 'no_requirements' })
  for (const item of requirementItems) {
    const match = REQUIREMENT.exec(item)
    if (match?.[1] === undefined) {
      findings.push({ code: 'requirement_without_id', text: item })
      continue
    }
    noteId(match[1])
    requirements.push({ id: match[1], text: match[2] ?? '' })
  }

  const criteria: SpecCriterion[] = []
  for (const item of found.get('acceptance criteria') ?? []) {
    const match = CRITERION.exec(item)
    if (match?.[1] === undefined) {
      findings.push({ code: 'criterion_without_id', text: item })
      continue
    }
    noteId(match[1])
    const refs = (match[2] ?? '').split(/[,\s]+/).filter((ref) => /^R\d+$/.test(ref))
    if (refs.length === 0) findings.push({ code: 'criterion_without_requirement', id: match[1] })
    criteria.push({ id: match[1], requirements: refs, text: match[3] ?? '' })
  }

  const known = new Set(requirements.map((r) => r.id))
  for (const criterion of criteria) {
    for (const ref of criterion.requirements) {
      if (!known.has(ref))
        findings.push({ code: 'unknown_requirement', id: criterion.id, text: ref })
    }
  }
  const covered = new Set(criteria.flatMap((c) => c.requirements))
  for (const requirement of requirements) {
    if (
      !covered.has(requirement.id) &&
      !findings.some((f) => f.code === 'duplicate_id' && f.id === requirement.id)
    ) {
      findings.push({ code: 'requirement_without_criterion', id: requirement.id })
    }
  }

  const openQuestions = (found.get('open questions') ?? []).filter((q) => q !== '')

  return {
    requirements,
    criteria,
    openQuestions,
    findings,
    approvable: findings.length === 0 && openQuestions.length === 0,
  }
}
