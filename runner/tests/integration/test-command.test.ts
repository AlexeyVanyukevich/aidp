import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { runTestCommand } from '../../src/test-command.js'

describe('runTestCommand', () => {
  it.each([
    ['a passing command', 'echo ok', 0, 'ok\n'],
    ['a failing command', 'echo broken >&2; exit 3', 3, 'broken\n'],
  ])('reports %s with its output', async (_name, command, exitCode, output) => {
    const run = await runTestCommand(command, tmpdir(), { timeoutMs: 10_000 })
    expect(run).toMatchObject({ exitCode, timedOut: false, output, truncated: false })
  })

  // Review Focus 5: megabytes of output keep only their tail.
  it('keeps only the last 64 KiB of a flood of output', async () => {
    const run = await runTestCommand('yes line | head -c 1000000; echo THE-END', tmpdir(), {
      timeoutMs: 30_000,
    })
    expect(run.truncated).toBe(true)
    expect(Buffer.byteLength(run.output)).toBeLessThanOrEqual(65_536)
    expect(run.output.endsWith('THE-END\n')).toBe(true)
  })

  // Review Focus 5: a command that never ends is stopped, with everything it ran.
  it('stops a command that outlives its timeout, children included', async () => {
    const started = Date.now()
    const run = await runTestCommand('echo started; sleep 30 & sleep 30', tmpdir(), {
      timeoutMs: 300,
    })
    expect(run).toMatchObject({ timedOut: true, exitCode: null })
    expect(run.output).toContain('started')
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
