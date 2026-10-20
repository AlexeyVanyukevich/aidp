// Stands in for `claude -p` in the scenario tests. It does what the script tells the named
// agent to do — through the same MCP server and the same hooks a real agent goes through —
// then replays a recorded stream, so usage and the result are real.
//
// The script maps each agent to its calls, each call a list of steps. `byTitle` maps a fragment
// of the task's title to a script of its own, so one script file serves several tasks. A
// session remembers its script, so `--resume` plays the same agent's next call.
//
// A call that asks the board for an answer and is told to stop does: it replays the recorded
// paused process and exits. A `{ stubborn: true }` step after the question keeps calling tools
// instead, which the guard refuses, until the runner ends the process.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

type Step =
  | { tool: string; args: Record<string, unknown> }
  | { edit: string; content: string }
  | { commit: string }
  | { sleep: number }
  | { exit: number }
  | { stubborn: true }
type Script = Record<string, Step[][]> & { byTitle?: Record<string, Record<string, Step[][]>> }

const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? '') : '')
const agent = flag('--agent')
const resumed = args.includes('--resume')
const sessionId = resumed ? flag('--resume') : flag('--session-id')
const prompt = flag('-p')
const settings = JSON.parse(readFileSync(flag('--settings'), 'utf8')) as {
  hooks: Record<string, { hooks: { command: string }[] }[]>
}

const scriptPath = process.env.FAKE_CLAUDE_SCRIPT!
const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as Script
const statePath = `${scriptPath}.calls.json`
const state = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, 'utf8')) as {
      calls: Record<string, number>
      sessions: Record<string, string>
    })
  : { calls: {}, sessions: {} }

// Which script: the session's own on a resume; else the title's, from the handoff's <task> tag.
const title = /<task [^>]*>([^<]*)<\/task>/.exec(prompt)?.[1] ?? ''
const chosen = resumed
  ? (state.sessions[sessionId] ?? 'default')
  : (Object.keys(script.byTitle ?? {}).find((fragment) => title.includes(fragment)) ?? 'default')
state.sessions[sessionId] = chosen
const scripts = chosen === 'default' ? script : (script.byTitle?.[chosen] ?? script)
const key = `${chosen}/${agent}`
const call = state.calls[key] ?? 0
state.calls[key] = call + 1
writeFileSync(statePath, JSON.stringify(state))
const steps = scripts[agent]?.[call] ?? scripts[agent]?.at(-1) ?? []

if (process.env.FAKE_CLAUDE_LOG)
  appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ agent, resumed, prompt })}\n`)

function hook(event: string, input: object): string {
  const command = settings.hooks[event]?.[0]?.hooks[0]?.command
  if (command === undefined) return ''
  return spawnSync('sh', ['-c', command], {
    input: JSON.stringify({ cwd: process.cwd(), ...input }),
    encoding: 'utf8',
    env: process.env,
  }).stdout
}

const print = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`)

/** A board tool, called as Claude Code calls one: the guard first, the event hook after. */
async function boardTool(tool: string, toolArgs: Record<string, unknown>): Promise<string | null> {
  const name = `mcp__board__${tool}`
  if (hook('PreToolUse', { tool_name: name, tool_input: toolArgs }).includes('"deny"')) {
    print({ type: 'system', subtype: 'fake_denied', tool: name })
    if (process.env.FAKE_CLAUDE_LOG)
      appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ agent, denied: name })}\n`)
    return null
  }
  const client = new Client({ name: 'fake-claude', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${process.env.BOARD_URL}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${process.env.BOARD_RUN_TOKEN}` } },
  })
  // The SDK's class and interface disagree under exactOptionalPropertyTypes; see mcp.routes.ts.
  await client.connect(transport as Transport)
  const result = await client.callTool({ name: tool, arguments: toolArgs })
  await client.close()
  const content = result.content as { type: string; text: string }[]
  print({ type: 'system', subtype: 'fake_tool', tool, is_error: result.isError === true })
  hook('PostToolUse', { tool_name: name, tool_input: toolArgs, tool_response: content })
  return content.map((c) => c.text).join('\n')
}

function replay(fixture: string): void {
  for (const line of readFileSync(
    join(import.meta.dirname, `../fixtures/stream/${fixture}.ndjson`),
    'utf8',
  ).split('\n')) {
    if (line === '') continue
    const parsed = JSON.parse(line) as Record<string, unknown>
    if ('session_id' in parsed) parsed.session_id = sessionId
    print(parsed)
  }
}

let paused = false
for (const step of steps) {
  if ('stubborn' in step) {
    // Told to end its turn, it goes on calling tools until the runner ends it.
    for (;;) {
      await boardTool('log_step', { summary: 'still going' })
      await new Promise((done) => setTimeout(done, 100))
    }
  }
  if (paused) break
  if ('tool' in step) {
    const reply = await boardTool(step.tool, step.args)
    if (reply?.startsWith('Paused:') === true) paused = true
  } else if ('edit' in step) {
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: step.edit, old_string: '', new_string: step.content },
    }
    if (hook('PreToolUse', input).includes('"deny"')) {
      print({ type: 'system', subtype: 'fake_denied', path: step.edit })
      continue
    }
    mkdirSync(dirname(join(process.cwd(), step.edit)), { recursive: true })
    writeFileSync(join(process.cwd(), step.edit), step.content)
    hook('PostToolUse', { ...input, tool_response: {} })
  } else if ('commit' in step) {
    execFileSync('git', ['add', '-A'])
    execFileSync('git', ['commit', '-q', '-m', step.commit])
  } else if ('sleep' in step) {
    await new Promise((done) => setTimeout(done, step.sleep))
  } else if ('exit' in step) {
    process.exit(step.exit)
  }
}

// The recorded stream that matches what the call did: a pause, a resumed process, or neither.
replay(paused ? 'pause-1' : resumed ? 'pause-2' : 'plain')
