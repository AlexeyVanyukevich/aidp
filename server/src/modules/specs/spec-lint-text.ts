import type { LintFinding, ParsedSpec } from './spec-parser.js'

/**
 * A lint finding in the Spec tab's words (`web/src/card/lint.ts`), for the spec-writer, which
 * reads what the owner reads. The web app keeps its own copy: it owns its words. Pure.
 */
export function lintText(finding: LintFinding): string {
  switch (finding.code) {
    case 'no_requirements':
      return 'The spec has no requirements.'
    case 'requirement_without_id':
      return `This requirement needs an id like R3: “${finding.text ?? ''}”.`
    case 'criterion_without_id':
      return `This criterion needs an id like AC3: “${finding.text ?? ''}”.`
    case 'criterion_without_requirement':
      return `${finding.id ?? ''} names no requirement.`
    case 'requirement_without_criterion':
      return `${finding.id ?? ''} has no acceptance criterion.`
    case 'unknown_requirement':
      return `${finding.id ?? ''} names ${finding.text ?? ''}, which is not a requirement.`
    case 'duplicate_id':
      return `${finding.id ?? ''} is used twice.`
    case 'unknown_marker':
      return `${finding.id ?? ''} has “${finding.text ?? ''}” in its parentheses, which is neither a requirement id nor owner.`
  }
}

/** What `save_spec` answers (slice 3 spec, §7): the version, and what stands in its way. */
export function lintReply(version: number, parsed: ParsedSpec): string {
  if (parsed.approvable) return `Saved v${version}. Lint: clean.`
  return [
    `Saved v${version}. It cannot be approved yet:`,
    ...parsed.findings.map((finding) => `- ${lintText(finding)}`),
    ...parsed.openQuestions.map((question) => `- Open question: ${question}`),
    'Fix these and save again.',
  ].join('\n')
}
