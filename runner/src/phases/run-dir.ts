import { mkdirSync, writeFileSync } from 'node:fs'
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

/** Written by the event hook when the board pauses the run; the guard refuses everything after. */
export const PAUSED_MARKER = 'paused'
