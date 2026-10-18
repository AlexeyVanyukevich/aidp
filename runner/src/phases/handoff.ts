export interface HandoffInput {
  taskKey: string
  title: string
  phase: 'plan' | 'build' | 'verify'
  attempt: number
  specVersion: number
  specMd: string
  budgetUsd: number | null
  summaries: { phase: string; attempt: number; text: string }[]
  plan?: string
  verifyReport?: string
  testOutput?: string
  diff?: string
}

const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const attr = (text: string) => escape(text).replaceAll('"', '&quot;')

function cut(label: string, text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[${label} cut: ${text.length - max} more characters]`
}

const RETURNS: Record<HandoffInput['phase'], string> = {
  plan: 'Call save_plan, then reply with one paragraph.',
  build:
    '<build_report status="done|blocked" files="…" tests="…" confidence="high|medium|low"/> and one paragraph.',
  verify: 'Call save_report with a verdict on every criterion, then reply with one paragraph.',
}

/** The platform design's handoff contract: the same tags for every phase. */
export function buildHandoff(input: HandoffInput): string {
  const parts = [
    `<task id="${attr(input.taskKey)}" phase="${input.phase}" attempt="${input.attempt}">${escape(input.title)}</task>`,
    `<spec version="${input.specVersion}">\n${escape(input.specMd)}\n</spec>`,
  ]
  if (input.summaries.length > 0) {
    parts.push(
      `<context>\n${input.summaries.map((s) => `<summary phase="${s.phase}" attempt="${s.attempt}">${escape(s.text)}</summary>`).join('\n')}\n</context>`,
    )
  }
  if (input.plan !== undefined) parts.push(`<plan>\n${escape(input.plan)}\n</plan>`)
  if (input.verifyReport !== undefined)
    parts.push(`<verify_report>\n${escape(input.verifyReport)}\n</verify_report>`)
  if (input.testOutput !== undefined)
    parts.push(
      `<test_output>\n${escape(cut('test output', input.testOutput, 20_000))}\n</test_output>`,
    )
  if (input.diff !== undefined)
    parts.push(`<diff>\n${escape(cut('diff', input.diff, 60_000))}\n</diff>`)
  parts.push(
    '<constraints>Work only inside this worktree. Never push. Stop and say so in your reply if the spec cannot be met as written.</constraints>',
  )
  if (input.budgetUsd !== null) parts.push(`<budget usd="${input.budgetUsd.toFixed(2)}"/>`)
  parts.push(`<return_format>${escape(RETURNS[input.phase])}</return_format>`)
  return parts.join('\n')
}
