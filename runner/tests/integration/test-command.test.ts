import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

  describe('environment', () => {
    const saved = { ...process.env }
    afterEach(() => {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    })

    const lines = (output: string) => output.split('\n')
    const homeOf = (output: string) => output.trim()

    it('strips the board variables, keeps the rest and gives a temporary BOARD_HOME', async () => {
      Object.assign(process.env, {
        RUNNER_KEY: 'k',
        DATABASE_URL: 'd',
        PORT: '1',
        BOARD_URL: 'u',
        BOARD_HOME: '/the/real/home',
        AIDP_TEST_KEEP: 'kept',
      })
      const run = await runTestCommand('env', tmpdir(), { timeoutMs: 10_000 })
      const out = lines(run.output)
      for (const name of ['RUNNER_KEY=', 'DATABASE_URL=', 'PORT=', 'BOARD_URL=']) {
        expect(out.some((line) => line.startsWith(name))).toBe(false)
      }
      expect(out).toContain('AIDP_TEST_KEEP=kept')
      const homes = out.filter((line) => line.startsWith('BOARD_HOME='))
      expect(homes).toHaveLength(1)
      const home = homes[0]!.slice('BOARD_HOME='.length)
      expect(basename(home).startsWith('aidp-command-')).toBe(true)
      expect(dirname(home)).toBe(tmpdir())
      expect(home).not.toBe('/the/real/home')
    })

    it('gives each call its own directory', async () => {
      const [a, b] = await Promise.all([
        runTestCommand('echo $BOARD_HOME', tmpdir(), { timeoutMs: 10_000 }),
        runTestCommand('echo $BOARD_HOME', tmpdir(), { timeoutMs: 10_000 }),
      ])
      expect(homeOf(a.output)).not.toBe(homeOf(b.output))
    })

    it('gives a directory that exists and is writable while the command runs', async () => {
      const run = await runTestCommand('echo x > "$BOARD_HOME/f" && ls "$BOARD_HOME"', tmpdir(), {
        timeoutMs: 10_000,
      })
      expect(run.exitCode).toBe(0)
      expect(run.output).toBe('f\n')
    })

    interface RemovalRow {
      name: string
      command: string
      exitCode: number | null
      timedOut: boolean
    }
    const REMOVAL: RemovalRow[] = [
      { name: 'exit 0', command: 'echo $BOARD_HOME; exit 0', exitCode: 0, timedOut: false },
      { name: 'exit 3', command: 'echo $BOARD_HOME; exit 3', exitCode: 3, timedOut: false },
      { name: 'timeout', command: 'echo $BOARD_HOME; sleep 30', exitCode: null, timedOut: true },
    ]
    it.each(REMOVAL)('removes the directory before resolving: $name', async (row) => {
      const run = await runTestCommand(row.command, tmpdir(), { timeoutMs: 300 })
      expect(existsSync(homeOf(run.output.split('\n')[0] ?? ''))).toBe(false)
      expect(run).toMatchObject({ exitCode: row.exitCode, timedOut: row.timedOut })
    })

    it('resolves when the command removes its own directory', async () => {
      const run = await runTestCommand('rmdir "$BOARD_HOME"; exit 0', tmpdir(), {
        timeoutMs: 10_000,
      })
      expect(run.exitCode).toBe(0)
    })

    it('does not run the command when no temporary directory can be made', async () => {
      const cwd = tmpdir()
      const marker = `marker-${crypto.randomUUID()}`
      process.env.TMPDIR = '/nonexistent/aidp-tmp'
      const run = await runTestCommand(`touch ${marker}`, cwd, { timeoutMs: 10_000 })
      expect(run).toMatchObject({ exitCode: null, timedOut: false, truncated: false })
      expect(run.output).toContain('No temporary BOARD_HOME could be created')
      expect(run.output).toContain('ENOENT')
      expect(existsSync(`${cwd}/${marker}`)).toBe(false)
    })
  })
})
