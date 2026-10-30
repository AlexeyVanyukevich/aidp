import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
