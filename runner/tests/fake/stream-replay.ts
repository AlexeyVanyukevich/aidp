// Usage: stream-replay <fixture> [--noise] [--exit <code>] [...claude's own flags, ignored]
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const fixture = args[0]!
const sessionId = args[args.indexOf('--session-id') + 1] ?? 'session'
if (args.includes('--noise'))
  process.stdout.write('Warning: something the CLI says that is not JSON\n\n')
for (const line of readFileSync(fixture, 'utf8').split('\n')) {
  if (line === '') continue
  const parsed = JSON.parse(line) as Record<string, unknown>
  if ('session_id' in parsed) parsed.session_id = sessionId
  process.stdout.write(`${JSON.stringify(parsed)}\n`)
}
process.stderr.write('a line on stderr\n')
const exit = args.indexOf('--exit')
process.exit(exit === -1 ? 0 : Number(args[exit + 1]))
