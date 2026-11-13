import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CLI_PATH } from '../self.js'
import { AGENTS } from './agents.js'
import { configDir } from './config-dir.js'

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

/** Everything a phase needs that must not end up in the target repository. */
export function prepareRunDir(
  dir: string,
  env: { CLAUDE_CONFIG_DIR?: string | undefined } = process.env,
  home: string = homedir(),
): void {
  mkdirSync(dir, { recursive: true })
  const command = (args: string) => ({ type: 'command', command: `${quote(CLI_PATH)} ${args}` })
  writeFileSync(join(dir, 'agents.json'), JSON.stringify(AGENTS))
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        // Empty text turns off the Co-Authored-By trailer and the pull request line; the
        // repository's commit convention has no place for them.
        attribution: { commit: '', pr: '' },
        // Claude Code saves a large tool result under the config directory and refuses a Read of
        // it unless allowed here; the guard narrows this to the session's own results.
        permissions: { allow: [`Read(/${configDir(env, home)}/projects/**/tool-results/**)`] },
        hooks: {
          PreToolUse: [{ matcher: '*', hooks: [command('guard')] }],
          PostToolUse: [{ matcher: '*', hooks: [command('event PostToolUse')] }],
          SubagentStart: [{ hooks: [command('event SubagentStart')] }],
          SubagentStop: [{ hooks: [command('event SubagentStop')] }],
        },
      },
      null,
      2,
    ),
  )
  // The URL and token are read from the process environment when Claude Code loads this file,
  // so the token never touches the disk.
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        board: {
          type: 'http',
          url: '${BOARD_URL}/mcp',
          headers: { Authorization: 'Bearer ${BOARD_RUN_TOKEN}' },
        },
      },
    }),
  )
}

/** The files Build may change: the plan's, and any the owner allowed since (spec §5). */
export function writeAllowedFiles(dir: string, files: string[]): void {
  writeFileSync(join(dir, 'allowed-files.json'), JSON.stringify(files))
}

/** A migration the owner approved, with the text they reviewed. */
export interface ApprovedMigration {
  path: string
  content: string
}

/** Whether a value is a list of `{ path, content }` entries, two strings each. */
export function isApprovedList(value: unknown): value is ApprovedMigration[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).path === 'string' &&
        typeof (item as Record<string, unknown>).content === 'string',
    )
  )
}

/** The migrations the owner approved, each with its content: the guard lets exactly these through. */
export function writeApprovedMigrations(dir: string, entries: ApprovedMigration[]): void {
  writeFileSync(join(dir, 'approved-migrations.json'), JSON.stringify(entries))
}

/** The project's base branch: the guard compares a new migration's name with `origin/<base>`. */
export function writeBaseBranch(dir: string, branch: string): void {
  writeFileSync(join(dir, 'base-branch.txt'), branch)
}

/** Written by the event hook when the board pauses the run; the guard refuses everything after. */
export const PAUSED_MARKER = 'paused'

/** Written when the runner's code moved under a phase; the next resume says so to the session. */
export const CODE_MOVED_MARKER = 'code-moved'

/** The runner's record of paths its own commands wrote; the gate does not count them. */
const EXCLUDED = 'excluded-paths.json'
/** What the gate found, worded for the next Build; the checkpoint carries only the marker. */
export const GATE_REPORT = 'files-gate-report.md'
/** The worktree's HEAD when the gate passed; Verify may not move it. */
export const GATE_HEAD = 'gate-head.txt'

/** The builder's paths the runner undid in the tests stage; the next Verify and Build are told. */
const UNDONE = 'undone-paths.json'

/** Empty when the file is missing or unreadable. */
export function readUndone(dir: string): string[] {
  try {
    return readList(dir, UNDONE)
  } catch {
    return []
  }
}
/** Adds paths to the record, sorted, each once. */
export function addUndone(dir: string, paths: string[]): void {
  if (paths.length === 0) return
  writeFileSync(
    join(dir, UNDONE),
    JSON.stringify([...new Set([...readUndone(dir), ...paths])].sort()),
  )
}
export function clearUndone(dir: string): void {
  writeFileSync(join(dir, UNDONE), '[]')
}

export function writeExcluded(dir: string, paths: string[]): void {
  writeFileSync(join(dir, EXCLUDED), JSON.stringify(paths))
}

/** A present file's JSON; a file that cannot be read or parsed throws, naming it. */
function readJson(dir: string, file: string): unknown {
  let text: string
  try {
    text = readFileSync(join(dir, file), 'utf8')
  } catch (error) {
    throw new Error(
      `${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** A present list must be an array of strings; anything else throws, naming the file. */
function readList(dir: string, file: string): string[] {
  const value = readJson(dir, file)
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new Error(`${file} is not an array of strings`)
  return value as string[]
}

const readListOr = <T>(dir: string, file: string, missing: T): string[] | T =>
  existsSync(join(dir, file)) ? readList(dir, file) : missing

/** Nothing is excluded when the record is missing; a present but malformed one throws. */
export const readExcluded = (dir: string): string[] => readListOr(dir, EXCLUDED, [])
/** Null before there is a plan. */
export const readAllowed = (dir: string): string[] | null =>
  readListOr(dir, 'allowed-files.json', null)
/** A file in the old form (plain strings) or otherwise malformed throws, naming the file. */
export function readApproved(dir: string): ApprovedMigration[] {
  const file = 'approved-migrations.json'
  if (!existsSync(join(dir, file))) return []
  const value = readJson(dir, file)
  if (!isApprovedList(value))
    throw new Error(`${file} is not an array of { path, content } entries`)
  return value
}

/**
 * The commits the run's base is tracked by. `setup`: the merge-base setup last ran on; `build`:
 * where Build's first attempt began; `tested`: the base the tests ran on; `verify`: the base the
 * last Verify was told about.
 */
export type BaseMark = 'setup' | 'build' | 'tested' | 'verify'
const markFile = (mark: BaseMark) => `${mark}-base.txt`

/** The commit a mark holds; null when the run never wrote it (a run from before the mark). */
export function readMark(dir: string, mark: BaseMark): string | null {
  const file = join(dir, markFile(mark))
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null
}
export function writeMark(dir: string, mark: BaseMark, commit: string): void {
  writeFileSync(join(dir, markFile(mark)), commit)
}
export function clearMark(dir: string, mark: BaseMark): void {
  rmSync(join(dir, markFile(mark)), { force: true })
}

/** What the tests stage found when the branch did not rebase onto the base; the next Build reads it. */
export const BASE_CONFLICT_REPORT = 'base-conflict-report.md'
/** What the runner wrote when the test command failed; the next Build reads it. */
export const TEST_COMMAND_REPORT = 'test-command-report.md'
const UNTESTED = 'untested-commits.json'

export interface UntestedCommit {
  sha: string
  subject: string
}
export function writeUntested(dir: string, commits: UntestedCommit[]): void {
  writeFileSync(join(dir, UNTESTED), JSON.stringify(commits))
}
export function clearUntested(dir: string): void {
  rmSync(join(dir, UNTESTED), { force: true })
}
/** The commits that reached the base after the tests; empty when none, or the file is missing. */
export function readUntested(dir: string): UntestedCommit[] {
  const file = join(dir, UNTESTED)
  if (!existsSync(file)) return []
  const value = readJson(dir, UNTESTED)
  if (
    !Array.isArray(value) ||
    !value.every(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as Record<string, unknown>).sha === 'string' &&
        typeof (c as Record<string, unknown>).subject === 'string',
    )
  )
    throw new Error(`${UNTESTED} is not an array of { sha, subject } entries`)
  return value as UntestedCommit[]
}

const PENDING_ANSWER = 'pending-answer.json'

/** The two phases that read the code again after a pause, each with its own base file. */
export type BasePhase = 'plan' | 'spec'
const baseFile = (phase: BasePhase) => `${phase}-base.txt`

/** The commit the phase last read from; null for a run paused before the file existed. */
export function readBase(dir: string, phase: BasePhase): string | null {
  const file = join(dir, baseFile(phase))
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null
}
export function writeBase(dir: string, phase: BasePhase, commit: string): void {
  writeFileSync(join(dir, baseFile(phase)), commit)
}

/** An answer taken from the owner and not yet delivered: words for the planner, or an approval. */
export type PendingAnswer = { kind: 'words'; text: string } | { kind: 'approved' }

export function writePendingAnswer(dir: string, answer: PendingAnswer): void {
  writeFileSync(join(dir, PENDING_ANSWER), JSON.stringify(answer))
}
export function readPendingAnswer(dir: string): PendingAnswer | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, PENDING_ANSWER), 'utf8')) as PendingAnswer
    if (value.kind === 'approved') return value
    if (value.kind === 'words' && typeof value.text === 'string') return value
    return null
  } catch {
    return null
  }
}
export function clearPendingAnswer(dir: string): void {
  rmSync(join(dir, PENDING_ANSWER), { force: true })
}
