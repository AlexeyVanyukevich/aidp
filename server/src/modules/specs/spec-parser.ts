import type { SpecCriterion } from '../../shared/vocabulary.js'

export type LintCode =
  | 'no_requirements'
  | 'requirement_without_id'
  | 'criterion_without_id'
  | 'criterion_without_requirement'
  | 'requirement_without_criterion'
  | 'unknown_requirement'
  | 'duplicate_id'
  | 'unknown_marker'
  | 'prose_in_list'

export interface LintFinding {
  code: LintCode
  id?: string
  section?: string
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
// A list item at the start of a line: `1.`, `1)`, `-`, `*` or `+`, followed by whitespace.
const ITEM = /^(?:\d+[.)]|[-*+])\s+(.*)$/
// A list marker with no text.
const BARE_MARKER = /^(?:\d+[.)]|[-*+])$/
const REQUIREMENT = /^(R\d+)\b\s*[–—:.)-]?\s*(.*)$/
const CRITERION = /^(AC\d+)\s*\(([^)]*)\)\s*[:.–—-]?\s*(.*)$/

type Entry = { kind: 'item'; first: string; tail: string } | { kind: 'prose'; text: string }

const LISTED = new Set(['requirements', 'acceptance criteria'])

/**
 * The entries under each `## heading`, keyed by the heading in lower case. A repeated heading
 * continues its section. Requirements and Acceptance criteria read items, an indented line
 * continuing the item above it; any other non-blank line there is prose. Other sections read
 * list items only, except Open questions, which reads every non-blank line.
 */
function sections(markdown: string): Map<string, Entry[]> {
  const result = new Map<string, Entry[]>()
  let current: Entry[] | undefined
  let key = ''
  let last: (Entry & { kind: 'item' }) | undefined
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const heading = HEADING.exec(line)
    if (heading?.[1] !== undefined) {
      key = heading[1].toLowerCase()
      current = result.get(key)
      if (current === undefined) {
        current = []
        result.set(key, current)
      }
      last = undefined
      continue
    }
    if (current === undefined) continue
    const trimmed = line.trim()
    if (trimmed === '') continue
    const item = ITEM.exec(line)
    if (LISTED.has(key)) {
      if (/^\s/.test(line)) {
        if (last !== undefined) last.tail += `\n${line}`
        else current.push({ kind: 'prose', text: trimmed })
      } else if (item?.[1] !== undefined) {
        last = { kind: 'item', first: item[1].trim(), tail: '' }
        current.push(last)
      } else if (!BARE_MARKER.test(trimmed)) {
        current.push({ kind: 'prose', text: trimmed })
      }
      continue
    }
    if (item?.[1] !== undefined) current.push({ kind: 'item', first: item[1].trim(), tail: '' })
    else if (key === 'open questions' && !BARE_MARKER.test(trimmed))
      current.push({ kind: 'item', first: trimmed, tail: '' })
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
  const prose = (section: string, text: string) =>
    findings.push({ code: 'prose_in_list', section, text })

  const requirements: { id: string; text: string }[] = []
  const requirementEntries = found.get('requirements') ?? []
  if (!requirementEntries.some((e) => e.kind === 'item')) findings.push({ code: 'no_requirements' })
  for (const entry of requirementEntries) {
    if (entry.kind === 'prose') {
      prose('Requirements', entry.text)
      continue
    }
    const match = REQUIREMENT.exec(entry.first)
    if (match?.[1] === undefined) {
      findings.push({ code: 'requirement_without_id', text: entry.first })
      continue
    }
    noteId(match[1])
    requirements.push({ id: match[1], text: (match[2] ?? '') + entry.tail })
  }

  const criteria: SpecCriterion[] = []
  for (const entry of found.get('acceptance criteria') ?? []) {
    if (entry.kind === 'prose') {
      prose('Acceptance criteria', entry.text)
      continue
    }
    const match = CRITERION.exec(entry.first)
    if (match?.[1] === undefined) {
      findings.push({ code: 'criterion_without_id', text: entry.first })
      continue
    }
    noteId(match[1])
    const tokens = (match[2] ?? '').split(/[,\s]+/).filter((token) => token !== '')
    const refs = tokens.filter((token) => /^R\d+$/.test(token))
    const owner = tokens.includes('owner')
    if (refs.length === 0) findings.push({ code: 'criterion_without_requirement', id: match[1] })
    for (const token of tokens) {
      if (!/^R\d+$/.test(token) && token !== 'owner')
        findings.push({ code: 'unknown_marker', id: match[1], text: token })
    }
    criteria.push({ id: match[1], requirements: refs, text: (match[3] ?? '') + entry.tail, owner })
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

  const openQuestions = (found.get('open questions') ?? [])
    .flatMap((e) => (e.kind === 'item' ? [e.first] : []))
    .filter((q) => q !== '')

  return {
    requirements,
    criteria,
    openQuestions,
    findings,
    approvable: findings.length === 0 && openQuestions.length === 0,
  }
}
