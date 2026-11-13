import type { PhaseName } from '../contract.js'
import { fenceMigration } from '../migration-content.js'

export interface HandoffInput {
  taskKey: string
  title: string
  phase: PhaseName
  attempt: number
  /** The approved spec a delivery phase works to; the version a redraft starts from. */
  specVersion?: number
  specMd?: string
  /** What a spec run drafts from. */
  description?: string
  /** What the owner asked a redraft to change. */
  note?: string
  budgetUsd: number | null
  summaries: { phase: string; attempt: number; text: string }[]
  plan?: string
  /** A planner starting again: the plans of earlier runs, newest first. Never a `<plan>`. */
  previousPlans?: { run: number; accepted: boolean; text: string }[] | undefined
  /** Spec phase only: the base branch and the commit the worktree reads. */
  base?: { branch: string; commit: string }
  /** The owner's words at plan gates on this spec version, oldest first; Plan and Verify only. */
  planAnswers?: { run: number; approved: boolean; text: string }[] | undefined
  /** Build only: the migrations the owner approved, each with the text they reviewed. */
  approvedMigrations?: { path: string; content: string }[] | undefined
  verifyReport?: string
  /** Verify only: the test output text and the absolute path of the file that holds all of it. */
  testOutput?: { text: string; path: string }
  /** Verify only: the diff and the absolute path of the file that holds all of it. */
  diff?: { text: string; path: string }
  /** The read-only checkouts of the projects this one links to. */
  linked?: LinkedElement[]
}

/** What a `<project>` element of `<linked_projects>` says about one linked checkout. */
interface LinkedElement {
  key: string
  name: string
  github_repo: string
  base_branch: string
  path: string
  note: string
}

export const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
export const attr = (text: string) => escape(text).replaceAll('"', '&quot;')

/** The `<linked_projects>` element of a phase handoff and of a decision help, by key. */
export function linkedProjects(linked: readonly LinkedElement[]): string {
  return `<linked_projects>\n${[...linked]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(
      (p) =>
        `<project key="${attr(p.key)}" name="${attr(p.name)}" github_repo="${attr(p.github_repo)}" base_branch="${attr(p.base_branch)}" path="${attr(p.path)}">${escape(p.note)}</project>`,
    )
    .join('\n')}\n</linked_projects>`
}

function cut(label: string, text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[${label} cut: ${text.length - max} more characters]`
}

export const DIFF_MAX = 60_000
export const TEST_OUTPUT_MAX = 20_000
const OUTPUT_CUT_LINE = '[output cut to its end]'

/** What a diff longer than the bound loses: its length past the bound, and the line it resumes on. */
export function diffCutPoint(diff: string): { more: number; line: number } {
  const kept = diff.slice(0, DIFF_MAX)
  return { more: diff.length - DIFF_MAX, line: kept.split('\n').length }
}

/** The diff as the handoff shows it: the first 60,000 characters and a marker naming the rest. */
export function diffCut(diff: string, path: string): string {
  if (diff.length <= DIFF_MAX) return diff
  const kept = diff.slice(0, DIFF_MAX)
  const { more, line } = diffCutPoint(diff)
  return `${kept}${kept.endsWith('\n') ? '' : '\n'}[diff cut: ${more} more characters; the rest begins at line ${line} of ${path}]`
}

/** The test-output text split into its head (its first line, and the runner's cut line) and rest. */
export function splitTestOutput(text: string): { head: string; rest: string } {
  const first = text.indexOf('\n')
  if (first === -1) return { head: '', rest: text }
  let end = first + 1
  if (text.startsWith(`${OUTPUT_CUT_LINE}\n`, end)) end += OUTPUT_CUT_LINE.length + 1
  return { head: text.slice(0, end), rest: text.slice(end) }
}

/** How many characters of the rest the test-output cut leaves out; 0 when it cuts nothing. */
export function testOutputLeftOut(text: string): number {
  return Math.max(0, splitTestOutput(text).rest.length - TEST_OUTPUT_MAX)
}

/** The test output as the handoff shows it: its head and the last 20,000 characters of the rest. */
export function testOutputCut(text: string, path: string): string {
  const { head, rest } = splitTestOutput(text)
  if (rest.length <= TEST_OUTPUT_MAX) return text
  const left = rest.length - TEST_OUTPUT_MAX
  return `${head}[test output cut: ${left} earlier characters; all of them are in ${path}]\n${rest.slice(left)}`
}

const PLAN_ANSWERS_MAX = 20_000

/** The newest answers that fit whole in the bound; the first that does not fit ends the walk. */
function planAnswerTags(answers: { run: number; approved: boolean; text: string }[]): string[] {
  let total = 0
  let kept = answers.length
  for (let i = answers.length - 1; i >= 0; i--) {
    total += answers[i]?.text.length ?? 0
    if (total > PLAN_ANSWERS_MAX) {
      kept = i + 1
      break
    }
    kept = i
  }
  const tags = answers
    .slice(kept)
    .map(
      (a) =>
        `<plan_answer run="${a.run}" approved="${a.approved ? 'yes' : 'no'}">\n${escape(a.text)}\n</plan_answer>`,
    )
  const left = answers.slice(0, kept)
  if (left.length > 0) {
    const runs = [...new Set(left.map((a) => a.run))].sort((a, b) => a - b)
    tags.push(`<plan_answers_left_out count="${left.length}" runs="${runs.join(',')}"/>`)
  }
  return tags
}

const RETURNS: Record<HandoffInput['phase'], string> = {
  spec: 'Call save_spec until the lint is clean, then reply with one paragraph.',
  plan: 'Call save_plan, then reply with one paragraph.',
  build:
    '<build_report status="done|blocked" files="…" tests="…" confidence="high|medium|low"/> and one paragraph.',
  verify: 'Call save_report with a verdict on every criterion, then reply with one paragraph.',
  title: 'Call suggest_title, then reply with one sentence.',
  rephrase: 'Call save_suggestion, then reply with one sentence.',
  help: 'Call save_help_result, then end your turn.',
}

/** The platform design's handoff contract: the same tags for every phase. */
export function buildHandoff(input: HandoffInput): string {
  const parts = [
    `<task id="${attr(input.taskKey)}" phase="${input.phase}" attempt="${input.attempt}">${escape(input.title)}</task>`,
  ]
  if (input.description !== undefined)
    parts.push(`<description>\n${escape(input.description)}\n</description>`)
  if (input.specVersion !== undefined && input.specMd !== undefined)
    parts.push(`<spec version="${input.specVersion}">\n${escape(input.specMd)}\n</spec>`)
  if (input.note !== undefined) parts.push(`<note>\n${escape(input.note)}\n</note>`)
  if (input.phase === 'spec' && input.base !== undefined)
    parts.push(`<base branch="${attr(input.base.branch)}" commit="${attr(input.base.commit)}"/>`)
  const summaries = input.summaries.filter((s) => s.phase !== 'help')
  if (summaries.length > 0) {
    parts.push(
      `<context>\n${summaries.map((s) => `<summary phase="${s.phase}" attempt="${s.attempt}">${escape(s.text)}</summary>`).join('\n')}\n</context>`,
    )
  }
  for (const previous of input.previousPlans ?? [])
    parts.push(
      `<previous_plan run="${previous.run}" accepted="${previous.accepted ? 'yes' : 'no'}">\n${escape(cut('previous plan', previous.text, 20_000))}\n</previous_plan>`,
    )
  if (input.phase === 'plan' || input.phase === 'verify')
    parts.push(...planAnswerTags(input.planAnswers ?? []))
  if (input.plan !== undefined) parts.push(`<plan>\n${escape(input.plan)}\n</plan>`)
  if (input.phase === 'build')
    for (const entry of [...(input.approvedMigrations ?? [])].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ))
      // The content is never escaped: its closing fence ends it, and a tag inside it is harmless.
      parts.push(
        `<approved_migration path="${attr(entry.path)}">\n${fenceMigration(entry.content)}\n</approved_migration>`,
      )
  if (input.verifyReport !== undefined)
    parts.push(`<verify_report>\n${escape(input.verifyReport)}\n</verify_report>`)
  if (input.testOutput !== undefined)
    parts.push(
      `<test_output>\n${escape(testOutputCut(input.testOutput.text, input.testOutput.path))}\n</test_output>`,
    )
  if (input.diff !== undefined)
    parts.push(`<diff>\n${escape(diffCut(input.diff.text, input.diff.path))}\n</diff>`)
  const linked = input.linked ?? []
  if (linked.length > 0) parts.push(linkedProjects(linked))
  parts.push(
    linked.length > 0
      ? '<constraints>Work only inside this worktree. The linked checkouts may be read and never changed. Never push. Stop and say so in your reply if the spec cannot be met as written.</constraints>'
      : '<constraints>Work only inside this worktree. Never push. Stop and say so in your reply if the spec cannot be met as written.</constraints>',
  )
  if (input.budgetUsd !== null) parts.push(`<budget usd="${input.budgetUsd.toFixed(2)}"/>`)
  parts.push(`<return_format>${escape(RETURNS[input.phase])}</return_format>`)
  return parts.join('\n')
}
