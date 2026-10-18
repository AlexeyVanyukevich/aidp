import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BoardApi } from './api.js'
import { decide, denyOutput } from './hooks/guard.js'
import { hookToEvent } from './hooks/hook-event.js'
import { EventSink } from './sink.js'

function env(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '')
    throw new Error(`${name} is not set; board-cli hooks run only inside a phase`)
  return value
}

async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
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
}

async function guard(): Promise<void> {
  const input = await readStdin()
  const runDir = env('BOARD_RUN_DIR')
  const planPath = join(runDir, 'plan-files.json')
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
      planFiles: existsSync(planPath)
        ? (JSON.parse(readFileSync(planPath, 'utf8')) as string[])
        : null,
      cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
      exists: existsSync,
    },
  )
  if (!verdict.allow) process.stdout.write(denyOutput(verdict.reason))
}

const [command, ...args] = process.argv.slice(2)
if (command === 'event') await event(args[0] ?? '')
else if (command === 'guard') await guard()
else {
  process.stderr.write('usage: board-cli event <PostToolUse|SubagentStart|SubagentStop> | guard\n')
  process.exit(2)
}
