import { showsOnlyLoadFailure } from './load-failure.js'

export interface Stub {
  file: string
  name?: string
  kept: 'stubbed' | 'whole'
}

/** A test seen failing: the command that ran it, and the line of its output where it failed. */
export interface FailingRun {
  name: string
  command: string
  way: 'before_code' | 'against_base'
  failing_line: string
  stubs?: Stub[]
  changed_assertions?: boolean
}

/** A test that cannot fail on the base, with the reason it holds. */
export interface ReasonEntry {
  name: string
  reason: 'guards_base' | 'refactor' | 'cannot_run'
  why: string
  changed_assertions?: boolean
}

export type BuildEntry = FailingRun | ReasonEntry

export const isReason = (entry: BuildEntry): entry is ReasonEntry => 'reason' in entry

export const NO_CALL = 'no Bash call in this Build phase ran the command'
export const NOT_KEPT =
  'the command ran in this Build phase, but the output kept from it (its last 64 KiB) does not contain the quoted failing line'
export const LOAD_ONLY =
  'the failing line shows only a load failure; a test is seen failing only once every file and name it imports has loaded, so stub the missing file or name, as your instructions say, and run the test again'

/** What a Bash call of the running phase left on the board: its command and its output's tail. */
export interface BashCall {
  command: string
  output: string
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
export const stripAnsi = (text: string) => text.replace(ANSI, '')

/** The first reason an entry is refused for, or null. A reason entry is not checked. */
export function refusalOf(entry: BuildEntry, calls: readonly BashCall[]): string | null {
  if (isReason(entry)) return null
  if (showsOnlyLoadFailure(entry.failing_line)) return LOAD_ONLY
  const command = entry.command.trim()
  const line = stripAnsi(entry.failing_line).trim()
  const matching = calls.filter((c) => c.command.trim() === command)
  if (matching.length === 0) return NO_CALL
  if (!matching.some((c) => stripAnsi(c.output).includes(line))) return NOT_KEPT
  return null
}

/** The refusal text of a call: one line per refused entry. */
export function refusalText(refused: { name: string; reason: string }[]): string {
  return [
    'The build report was not saved:',
    ...refused.map((r) => `- ${r.name}: ${r.reason}`),
  ].join('\n')
}

const yes = (flag: boolean | undefined) => (flag === true ? 'yes' : 'no')
const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ')

/** The Markdown a saved report is shown as. */
export function renderBuildReport(tests: readonly BuildEntry[]): string {
  return tests
    .map((t) => {
      if (isReason(t))
        return `- ${cell(t.name)}: ${t.reason}, ${cell(t.why)} (changed assertions: ${yes(t.changed_assertions)})`
      const stubs = (t.stubs ?? []).map(
        (s) => `  - ${s.kept}: ${cell(s.file)}${s.name === undefined ? '' : ` ${cell(s.name)}`}`,
      )
      return [
        `- ${cell(t.name)}: ${t.way}, \`${cell(t.command)}\`, failed at "${cell(t.failing_line)}" (changed assertions: ${yes(t.changed_assertions)})`,
        ...stubs,
      ].join('\n')
    })
    .join('\n')
}
