/** The longest title and reason `suggest_title` accepts. */
export const TITLE_LIMITS = { title: 200, reason: 300 } as const

export interface TitleFinding {
  field: 'title' | 'reason'
  code: 'blank' | 'too_long' | 'multiline'
}

const ONE_LINE = /[\r\n\u2028\u2029]/

function checkLine(field: TitleFinding['field'], text: string): TitleFinding[] {
  const findings: TitleFinding[] = []
  if (text.trim() === '') findings.push({ field, code: 'blank' })
  if (text.length > TITLE_LIMITS[field]) findings.push({ field, code: 'too_long' })
  if (ONE_LINE.test(text)) findings.push({ field, code: 'multiline' })
  return findings
}

/** Pure: what is wrong with a suggested title and its reason; empty when both are fit to store. */
export function checkSuggestion(input: { title: string; reason: string }): TitleFinding[] {
  return [...checkLine('title', input.title), ...checkLine('reason', input.reason)]
}

/** The refusal the agent reads: each finding names its field. */
export function suggestionRefusal(findings: TitleFinding[]): string {
  return [
    'The title was not stored:',
    ...findings.map((f) =>
      f.code === 'blank'
        ? `- ${f.field}: must not be blank`
        : f.code === 'multiline'
          ? `- ${f.field}: must be one line`
          : `- ${f.field}: at most ${TITLE_LIMITS[f.field]} characters`,
    ),
  ].join('\n')
}
