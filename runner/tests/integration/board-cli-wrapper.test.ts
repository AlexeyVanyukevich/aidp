import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
