// Stands in for `claude -p` in the scenario tests. It does what the script tells the named
// agent to do — through the same MCP server and the same hooks a real agent goes through —
// then replays a recorded stream, so usage and the result are real.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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

const args = process.argv.slice(2)
const flag = (name: string) => args[args.indexOf(name) + 1] ?? ''
const agent = flag('--agent')
const sessionId = flag('--session-id')
const settings = JSON.parse(readFileSync(flag('--settings'), 'utf8')) as {
  hooks: Record<string, { hooks: { command: string }[] }[]>
}

const scriptPath = process.env.FAKE_CLAUDE_SCRIPT!
const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as Record<string, Step[][]>
const statePath = `${scriptPath}.calls.json`
const calls = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, number>)
  : {}
const call = calls[agent] ?? 0
writeFileSync(statePath, JSON.stringify({ ...calls, [agent]: call + 1 }))
const steps = script[agent]?.[call] ?? script[agent]?.at(-1) ?? []

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

for (const step of steps) {
  if ('tool' in step) {
    const client = new Client({ name: 'fake-claude', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${process.env.BOARD_URL}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${process.env.BOARD_RUN_TOKEN}` } },
    })
    // The SDK's class and interface disagree under exactOptionalPropertyTypes; see mcp.routes.ts.
    await client.connect(transport as Transport)
    const result = await client.callTool({ name: step.tool, arguments: step.args })
    print({
      type: 'system',
      subtype: 'fake_tool',
      tool: step.tool,
      is_error: result.isError === true,
    })
    await client.close()
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

for (const line of readFileSync(
  join(import.meta.dirname, '../fixtures/stream/plain.ndjson'),
  'utf8',
).split('\n')) {
  if (line === '') continue
  const parsed = JSON.parse(line) as Record<string, unknown>
  if ('session_id' in parsed) parsed.session_id = sessionId
  print(parsed)
}
