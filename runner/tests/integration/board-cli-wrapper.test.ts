import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI_PATH } from '../../src/self.js'

/** A copy of the wrapper beside a stand-in `tsx` that echoes stdin, writes to stderr and exits. */
function standIn(status: number): string {
  const root = mkdtempSync(join(tmpdir(), 'wrapper-'))
  mkdirSync(join(root, 'runner/bin'), { recursive: true })
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
  const wrapper = join(root, 'runner/bin/board-cli')
  copyFileSync(CLI_PATH, wrapper)
  chmodSync(wrapper, 0o755)
  const tsx = join(root, 'node_modules/.bin/tsx')
  writeFileSync(tsx, `#!/bin/sh\ncat\necho "stand-in stderr" >&2\nexit ${status}\n`)
  chmodSync(tsx, 0o755)
  return wrapper
}

interface Row {
  name: string
  args: string[]
  exits: number
  status: number
}
const ROWS: Row[] = [
  { name: 'guard failing with 1 exits 2', args: ['guard'], exits: 1, status: 2 },
  { name: 'guard succeeding exits 0', args: ['guard'], exits: 0, status: 0 },
  { name: 'event failing with 1 exits 1', args: ['event', 'PostToolUse'], exits: 1, status: 1 },
]

describe('the board-cli wrapper', () => {
  it.each(ROWS)('AC7: $name', ({ args, exits, status }) => {
    const result = spawnSync(standIn(exits), args, { input: 'piped input', encoding: 'utf8' })
    expect(result.status).toBe(status)
    expect(result.stdout).toBe('piped input')
    expect(result.stderr).toContain('stand-in stderr')
  })
})

/**
 * A copy of the wrapper beside a stand-in `tsx` that runs a scripted sequence of exit statuses,
 * one per call (the last repeats), logging each call to `calls`. `body` runs before the exit.
 */
function scripted(statuses: number[], body: string | ((wrapper: string) => string) = '') {
  const wrapper = standIn(0)
  const root = join(wrapper, '../../..')
  const calls = join(root, 'calls')
  const tsx = join(root, 'node_modules/.bin/tsx')
  writeFileSync(
    tsx,
    `#!/bin/sh
echo call >> "${calls}"
n=$(wc -l < "${calls}" | tr -d ' ')
${typeof body === 'string' ? body : body(wrapper)}
set -- ${statuses.join(' ')}
i=1
for s in "$@"; do
  if [ "$i" -eq "$n" ] || [ "$i" -eq "$#" ]; then exit "$s"; fi
  i=$((i + 1))
done
`,
  )
  chmodSync(tsx, 0o755)
  const count = () =>
    existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0
  return { wrapper, count }
}

const FAST = { ...process.env, BOARD_CLI_RETRY_SECONDS: '0' }

describe('the board-cli wrapper running the daemon', () => {
  interface Sequence {
    name: string
    statuses: number[]
    calls: number
    status: number
    stderr: string | null
  }
  const SEQUENCES: Sequence[] = [
    { name: '75, 0', statuses: [75, 0], calls: 2, status: 0, stderr: null },
    { name: '1', statuses: [1], calls: 1, status: 1, stderr: null },
    {
      name: '75, 1, 0',
      statuses: [75, 1, 0],
      calls: 3,
      status: 0,
      stderr: "board-cli: the runner's code did not start (exit 1)",
    },
  ]
  it.each(SEQUENCES)('AC15: $name', (row) => {
    const { wrapper, count } = scripted(row.statuses)
    const result = spawnSync(wrapper, ['daemon'], { encoding: 'utf8', env: FAST })
    expect(count()).toBe(row.calls)
    expect(result.status).toBe(row.status)
    if (row.stderr !== null) expect(result.stderr).toContain(row.stderr)
    else expect(result.stderr).not.toContain('did not start')
  })

  it('retries every later failure, not only the first after a restart', () => {
    const { wrapper, count } = scripted([75, 1, 2, 0])
    const result = spawnSync(wrapper, ['daemon'], { encoding: 'utf8', env: FAST })
    expect(count()).toBe(4)
    expect(result.stderr).toContain('(exit 1)')
    expect(result.stderr).toContain('(exit 2)')
  })

  // AC16: the signal goes to the wrapper's process group, as ./run stop and Ctrl-C send it.
  const SIGNALS: { name: string; statuses: number[]; body: string; signal: NodeJS.Signals }[] = [
    {
      name: 'SIGTERM while the stand-in sleeps',
      statuses: [0],
      body: 'sleep 30',
      signal: 'SIGTERM',
    },
    { name: 'SIGINT while the stand-in sleeps', statuses: [0], body: 'sleep 30', signal: 'SIGINT' },
    {
      name: 'SIGTERM during the wait after 75, 1',
      statuses: [75, 1],
      body: '',
      signal: 'SIGTERM',
    },
  ]
  it.each(SIGNALS)('AC16: $name ends the wrapper and starts nothing', async (row) => {
    const { wrapper, count } = scripted(row.statuses, row.statuses.length > 1 ? '' : row.body)
    const during = row.statuses.length > 1
    const child = spawn(wrapper, ['daemon'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, BOARD_CLI_RETRY_SECONDS: during ? '30' : '0' },
    })
    const ended = new Promise<void>((done) => child.on('close', () => done()))
    const reached = during ? 2 : 1
    for (let i = 0; i < 200 && count() < reached; i++) await new Promise((r) => setTimeout(r, 25))
    await new Promise((r) => setTimeout(r, 200))
    const before = count()
    process.kill(-child.pid!, row.signal)
    await ended
    await new Promise((r) => setTimeout(r, 300))
    expect(count()).toBe(before)
  })

  it('passes a SIGTERM sent to the wrapper alone on to the daemon, which ends the wrapper', async () => {
    const { wrapper, count } = scripted(
      [0],
      (path) =>
        `trap 'echo stopped > "${join(path, '../../../stopped')}"; exit 0' TERM; sleep 30 & wait`,
    )
    const child = spawn(wrapper, ['daemon'], { stdio: 'ignore' })
    const ended = new Promise<number | null>((done) => child.on('close', (code) => done(code)))
    for (let i = 0; i < 200 && count() < 1; i++) await new Promise((r) => setTimeout(r, 25))
    await new Promise((r) => setTimeout(r, 200))
    child.kill('SIGTERM')
    expect(await ended).toBe(0)
    expect(count()).toBe(1)
    expect(existsSync(join(wrapper, '../../../stopped'))).toBe(true)
  })

  it('AC17: still starts the stand-in a second time when the first call rewrites the wrapper', () => {
    const { wrapper, count } = scripted(
      [75, 0],
      (path) =>
        `if [ "$n" -eq 1 ]; then printf '#!/bin/sh\\necho rewritten >&2\\nexit 99\\n' > "${path}"; fi`,
    )
    const result = spawnSync(wrapper, ['daemon'], { encoding: 'utf8', env: FAST })
    expect(count()).toBe(2)
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('rewritten')
  })
})
