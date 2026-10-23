import { describe, expect, it } from 'vitest'
import { parseSpec, type LintFinding } from '../../src/modules/specs/spec-parser.js'
import { lintReply, lintText } from '../../src/modules/specs/spec-lint-text.js'

// The Spec tab's words (`web/src/card/lint.ts`), which the spec-writer reads as the owner does.
describe('lintText', () => {
  it.each<[LintFinding, string]>([
    [{ code: 'no_requirements' }, 'The spec has no requirements.'],
    [
      { code: 'requirement_without_id', text: 'It retries' },
      'This requirement needs an id like R3: “It retries”.',
    ],
    [
      { code: 'criterion_without_id', text: 'Given a 503' },
      'This criterion needs an id like AC3: “Given a 503”.',
    ],
    [{ code: 'criterion_without_requirement', id: 'AC2' }, 'AC2 names no requirement.'],
    [{ code: 'requirement_without_criterion', id: 'R2' }, 'R2 has no acceptance criterion.'],
    [
      { code: 'unknown_requirement', id: 'AC1', text: 'R9' },
      'AC1 names R9, which is not a requirement.',
    ],
    [{ code: 'duplicate_id', id: 'R1' }, 'R1 is used twice.'],
  ])('words %o', (finding, words) => {
    expect(lintText(finding)).toBe(words)
  })
})

const spec = (requirements: string, criteria: string, questions = '') =>
  `## Requirements\n${requirements}\n\n## Acceptance criteria\n${criteria}\n\n## Open questions\n${questions}\n`

describe('lintReply', () => {
  it.each<[string, string, string]>([
    [
      'a clean spec',
      spec('1. R1 – It retries', '- AC1 (R1): Given a 503 Then it retries'),
      'Saved v3. Lint: clean.',
    ],
    [
      'a requirement without a criterion',
      spec('1. R1 – It retries\n2. R2 – It waits', '- AC1 (R1): Given a 503 Then it retries'),
      'Saved v3. It cannot be approved yet:\n- R2 has no acceptance criterion.\nFix these and save again.',
    ],
    [
      'an open question left in the spec',
      spec('1. R1 – It retries', '- AC1 (R1): Given a 503 Then it retries', '- How many times?'),
      'Saved v3. It cannot be approved yet:\n- Open question: How many times?\nFix these and save again.',
    ],
    [
      // Task 4's recording: Opus, told only the sections' names, bolded its ids.
      'ids in bold, which the parser does not read as ids',
      spec('- **R1** It retries', '- **AC1 (R1)** Given a 503 Then it retries'),
      'Saved v3. It cannot be approved yet:\n- This requirement needs an id like R3: “**R1** It retries”.\n- This criterion needs an id like AC3: “**AC1 (R1)** Given a 503 Then it retries”.\nFix these and save again.',
    ],
  ])('%s', (_name, body, reply) => {
    expect(lintReply(3, parseSpec(body))).toBe(reply)
  })
})
