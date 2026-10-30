import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLI_PATH } from '../self.js'
import { AGENTS } from './agents.js'

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

/** Everything a phase needs that must not end up in the target repository. */
export function prepareRunDir(dir: string): void {
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

/** The migrations the owner approved: the guard lets these through (and only these). */
export function writeApprovedMigrations(dir: string, files: string[]): void {
  writeFileSync(join(dir, 'approved-migrations.json'), JSON.stringify(files))
}

/** The project's base branch: the guard compares a new migration's name with `origin/<base>`. */
export function writeBaseBranch(dir: string, branch: string): void {
  writeFileSync(join(dir, 'base-branch.txt'), branch)
}

/** Written by the event hook when the board pauses the run; the guard refuses everything after. */
export const PAUSED_MARKER = 'paused'

/** The runner's record of paths its own commands wrote; the gate does not count them. */
const EXCLUDED = 'excluded-paths.json'
/** What the gate found, worded for the next Build; the checkpoint carries only the marker. */
export const GATE_REPORT = 'files-gate-report.md'
/** The worktree's HEAD when the gate passed; Verify may not move it. */
export const GATE_HEAD = 'gate-head.txt'

export function writeExcluded(dir: string, paths: string[]): void {
  writeFileSync(join(dir, EXCLUDED), JSON.stringify(paths))
}

const readList = (dir: string, file: string): string[] =>
  existsSync(join(dir, file)) ? (JSON.parse(readFileSync(join(dir, file), 'utf8')) as string[]) : []

/** Nothing is excluded when the record is missing. */
export const readExcluded = (dir: string): string[] => readList(dir, EXCLUDED)
/** Null before there is a plan. */
export const readAllowed = (dir: string): string[] | null =>
  existsSync(join(dir, 'allowed-files.json')) ? readList(dir, 'allowed-files.json') : null
export const readApproved = (dir: string): string[] => readList(dir, 'approved-migrations.json')

const PLAN_BASE = 'plan-base.txt'
const PENDING_ANSWER = 'pending-answer.json'

/** The commit the planner last read from; null for a run paused before the file existed. */
export function readPlanBase(dir: string): string | null {
  const file = join(dir, PLAN_BASE)
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null
}
export function writePlanBase(dir: string, commit: string): void {
  writeFileSync(join(dir, PLAN_BASE), commit)
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
