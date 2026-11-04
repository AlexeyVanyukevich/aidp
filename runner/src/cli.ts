import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BoardApi } from './api.js'
import { realExec } from './exec.js'
import { formatViolations, violationsOf } from './files-gate.js'
import { Git } from './git.js'
import { decide, denyOutput } from './hooks/guard.js'
import { hookToEvent, pausedBy } from './hooks/hook-event.js'
import { readLinkedStrict } from './linked.js'
import { readMigrationSiblings } from './hooks/migration-siblings.js'
import { PAUSED_MARKER, readAllowed, readApproved, readExcluded } from './phases/run-dir.js'
import { EventSink } from './sink.js'
import { canonicalPath } from './worktree-log.js'

function env(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '')
    throw new Error(`${name} is not set; board-cli hooks run only inside a phase`)
  return value
}

/** The run's worktree from `BOARD_WORKTREE`, at its real path; the reason when it cannot be had. */
function worktreeOf(): { path: string } | { reason: string } {
  const value = process.env.BOARD_WORKTREE
  if (value === undefined || value === '')
    return { reason: 'BOARD_WORKTREE is not set, so the worktree is unknown' }
  try {
    return { path: realpathSync(value) }
  } catch (error) {
    return { reason: `BOARD_WORKTREE is ${value}, which does not resolve: ${String(error)}` }
  }
}

async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
}

/**
 * After a Bash call in Build: the files it left changed that the run does not allow, worded for
 * the builder; null when there are none, and null for any reason of the board's own, since a hook
 * blocks only for a violation it actually found.
 */
async function filesFeedback(
  input: Record<string, unknown>,
  runDir: string,
): Promise<string | null> {
  try {
    if (process.env.BOARD_PHASE !== 'build' || input.tool_name !== 'Bash') return null
    const allowed = readAllowed(runDir)
    const basePath = join(runDir, 'base-branch.txt')
    if (allowed === null || !existsSync(basePath)) return null
    const worktree = worktreeOf()
    if ('reason' in worktree)
      return `The files check could not run: ${worktree.reason}. Tell the owner; do not work around it.`
    const changed = await new Git(realExec, 'gh').changedPaths(
      worktree.path,
      readFileSync(basePath, 'utf8').trim(),
    )
    const found = violationsOf({
      committed: changed.committed,
      uncommitted: changed.uncommitted,
      excluded: readExcluded(runDir),
      allowed,
      approvedMigrations: readApproved(runDir),
    })
    return found.length === 0 ? null : formatViolations(found, changed.mergeBase)
  } catch {
    return null
  }
}

/**
 * A hook must never fail the agent's tool call for a reason of the board's own: the event is
 * buffered and the hook exits 0. Only the guard's verdict changes what the agent may do.
 */
async function event(name: string): Promise<void> {
  if (name !== 'PostToolUse' && name !== 'SubagentStart' && name !== 'SubagentStop')
    throw new Error(`unknown hook ${name}`)
  const input = await readStdin()
  const runDir = env('BOARD_RUN_DIR')
  // Before the event is sent: the marker must be down even if the board cannot be reached.
  if (name === 'PostToolUse' && pausedBy(input)) writeFileSync(join(runDir, PAUSED_MARKER), '')
  const sink = new EventSink(
    new BoardApi(env('BOARD_URL'), ''),
    join(runDir, 'events.ndjson'),
    () => env('BOARD_RUN_TOKEN'),
  )
  const ctx = {
    runId: env('BOARD_RUN_ID'),
    phaseId: env('BOARD_PHASE_ID'),
    agent: env('BOARD_AGENT'),
  }
  try {
    await sink.send([hookToEvent(name, input, ctx)])
  } catch (error) {
    process.stderr.write(`board-cli: event not recorded: ${String(error)}\n`)
  }
  if (name === 'PostToolUse') {
    const reason = await filesFeedback(input, runDir)
    if (reason !== null) process.stdout.write(JSON.stringify({ decision: 'block', reason }))
  }
}

/**
 * Claude Code blocks a call only on exit 2 or a `deny` on stdout; any other failure lets the call
 * go ahead. So a guard that cannot check a call refuses it, and says why on both streams.
 */
async function guard(): Promise<void> {
  try {
    await check()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`board-cli guard: ${message}\n`)
    process.stdout.write(
      denyOutput(
        `The guard could not check this call: ${message}. End your turn, and say why in your last message; do not work around it.`,
      ),
    )
  }
}

async function check(): Promise<void> {
  const input = await readStdin()
  const runDir = env('BOARD_RUN_DIR')
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd()
  const basePath = join(runDir, 'base-branch.txt')
  const worktree = worktreeOf()
  if ('reason' in worktree) {
    process.stdout.write(
      denyOutput(`The worktree is unknown, so no tool call is allowed: ${worktree.reason}`),
    )
    return
  }
  const base = existsSync(basePath) ? readFileSync(basePath, 'utf8').trim() : null
  const verdict = decide(
    {
      tool_name: typeof input.tool_name === 'string' ? input.tool_name : '',
      tool_input:
        typeof input.tool_input === 'object' && input.tool_input !== null
          ? (input.tool_input as Record<string, unknown>)
          : {},
    },
    {
      phase: env('BOARD_PHASE'),
      allowedFiles: readAllowed(runDir),
      approvedMigrations: readApproved(runDir),
      paused: existsSync(join(runDir, PAUSED_MARKER)),
      linked: readLinkedStrict(runDir),
      cwd,
      worktree: worktree.path,
      canonical: canonicalPath,
      exists: existsSync,
      migrationSiblings: (directory) => readMigrationSiblings(worktree.path, base, directory),
    },
  )
  if (!verdict.allow) process.stdout.write(denyOutput(verdict.reason))
}

const [command, ...args] = process.argv.slice(2)
if (command === 'event') await event(args[0] ?? '')
else if (command === 'guard') await guard()
else if (command === 'daemon') {
  const { main } = await import('./daemon.js')
  await main()
} else {
  process.stderr.write(
    'usage: board-cli daemon | event <PostToolUse|SubagentStart|SubagentStop> | guard\n',
  )
  process.exit(2)
}
