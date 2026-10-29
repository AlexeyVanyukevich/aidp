import type { LintFinding, SpecView, TaskState } from '../types'

export function lintMessage(finding: LintFinding): string {
  switch (finding.code) {
    case 'no_requirements':
      return 'The spec has no requirements.'
    case 'requirement_without_id':
      return `This requirement needs an id like R3: “${finding.text}”.`
    case 'criterion_without_id':
      return `This criterion needs an id like AC3: “${finding.text}”.`
    case 'criterion_without_requirement':
      return `${finding.id} names no requirement.`
    case 'requirement_without_criterion':
      return `${finding.id} has no acceptance criterion.`
    case 'unknown_requirement':
      return `${finding.id} names ${finding.text}, which is not a requirement.`
    case 'duplicate_id':
      return `${finding.id} is used twice.`
    case 'unknown_marker':
      return `${finding.id} has “${finding.text}” in its parentheses, which is neither a requirement id nor owner.`
    default:
      return finding.code
  }
}

/** Where `save_spec` is allowed (spec §5); everywhere else the spec is frozen or not yet due. */
export function editable(state: TaskState): boolean {
  return state === 'backlog' || state === 'spec_review'
}

/** What the Spec tab offers in a state (slice 3 spec, §11). */
export function specControls(state: TaskState): {
  /** The description can be edited and saved. */
  describe: boolean
  /** Draft spec: the spec-writer drafts a first version. */
  draft: boolean
  /** Redraft: the latest version goes back with a note. */
  redraft: boolean
  /** The spec-writer is drafting; the editor waits. */
  drafting: boolean
} {
  return {
    describe: state === 'backlog' || state === 'spec_review',
    draft: state === 'backlog',
    redraft: state === 'spec_review',
    drafting: state === 'spec_draft',
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function lintSummary(lint: SpecView['lint']): string {
  return `The spec lints clean: ${plural(lint.requirements.length, 'requirement')}, ${plural(
    lint.criteria.length,
    'criterion',
    'criteria',
  )}.`
}

/** What the card's status region says once a version is saved. */
export function savedMessage(spec: Pick<SpecView, 'version' | 'lint'>): string {
  if (spec.lint.approvable) return `Saved v${spec.version}. It lints clean and can be approved.`
  const issues = spec.lint.findings.length + spec.lint.open_questions.length
  return `Saved v${spec.version}. It cannot be approved yet: ${plural(issues, 'thing')} to fix, listed under Lint.`
}

export const SPEC_TEMPLATE = `## Goal
One sentence: what changes for whom.

## Context
Links, related tasks, relevant files and modules.

## Requirements
1. R1 – testable statement

## Acceptance criteria
- AC1 (R1): Given … When … Then …

## Out of scope

## Constraints
Tech stack, performance, security, compatibility.

## Open questions
`
