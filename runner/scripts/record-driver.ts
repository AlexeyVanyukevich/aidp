// Runs the real claude CLI for record-stream.sh, writing its stdout to a file, and stops it with
// a signal at a chosen point so the recordings can show what a stopped process leaves behind.
//
//   tsx record-driver.ts --out <file> [--stderr <file>] [--stop term|kill --at init|text:N] -- <args>
//
// `--at text:N` sends the signal once one message has streamed N text deltas — a reply being
// written, whichever message it is; how a model groups its tool calls into messages varies.
import { spawn } from 'node:child_process'
import { createWriteStream, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const split = process.argv.indexOf('--')
const own = process.argv.slice(2, split)
const claudeArgs = process.argv.slice(split + 1)
const option = (name: string) => {
  const at = own.indexOf(name)
  return at === -1 ? undefined : own[at + 1]
}
const out = option('--out')
const stderrFile = option('--stderr')
const stop = option('--stop')
const at = option('--at')
if (split === -1 || out === undefined) throw new Error('usage: --out <file> [...] -- <claude args>')
if (process.env.ANTHROPIC_API_KEY)
  throw new Error('ANTHROPIC_API_KEY is set: recordings go through the subscription, not the API')

const afterDeltas = at?.startsWith('text:') ? Number(at.slice('text:'.length)) : undefined
if (stop !== undefined && at !== 'init' && (afterDeltas === undefined || !(afterDeltas > 0)))
  throw new Error('--stop needs --at init or --at text:N')
const file = createWriteStream(out)
const child = spawn('claude', claudeArgs, {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ANTHROPIC_API_KEY: '' },
})
let stderr = ''
child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))

let deltas = 0
let sent = false
const signal = () => {
  sent = true
  child.kill(stop === 'term' ? 'SIGTERM' : 'SIGKILL')
}
createInterface({ input: child.stdout }).on('line', (line) => {
  file.write(`${line}\n`)
  if (stop === undefined || sent) return
  let parsed: {
    type?: string
    subtype?: string
    event?: { type?: string; delta?: { type?: string } }
  }
  try {
    parsed = JSON.parse(line) as typeof parsed
  } catch {
    return
  }
  if (at === 'init') {
    if (parsed.type === 'system' && parsed.subtype === 'init') signal()
    return
  }
  if (parsed.type !== 'stream_event') return
  if (parsed.event?.type === 'message_start') deltas = 0
  if (parsed.event?.type === 'content_block_delta' && parsed.event.delta?.type === 'text_delta')
    if (++deltas >= (afterDeltas ?? Infinity)) signal()
})

child.on('close', (code, signalName) => {
  file.end()
  if (stderrFile !== undefined) writeFileSync(stderrFile, stderr)
  console.log(`  ${out}: exit ${code ?? signalName}${sent ? `, stopped with ${stop}` : ''}`)
})
