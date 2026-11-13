import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childEnv } from './child-env.js'

export interface TestRun {
  exitCode: number | null
  timedOut: boolean
  output: string
  truncated: boolean
  durationMs: number
}

/**
 * The project's own test command, run by the runner rather than an agent, so Verify always
 * sees what the suite says. Output and time are bounded: a flood keeps its tail, which is where
 * a test runner prints its summary, and a hang is killed with everything it started.
 */
export async function runTestCommand(
  command: string,
  cwd: string,
  options: { timeoutMs: number; maxBytes?: number },
): Promise<TestRun> {
  const maxBytes = options.maxBytes ?? 65_536
  const started = Date.now()
  let home: string
  try {
    home = await mkdtemp(join(tmpdir(), 'aidp-command-'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      exitCode: null,
      timedOut: false,
      output: `No temporary BOARD_HOME could be created, so the command did not run: ${message}\n`,
      truncated: false,
      durationMs: Date.now() - started,
    }
  }
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: { ...childEnv(process.env), BOARD_HOME: home },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = Buffer.alloc(0)
    let truncated = false
    const keep = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > maxBytes) {
        buffer = buffer.subarray(buffer.length - maxBytes)
        truncated = true
      }
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)

    let timedOut = false
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal)
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill('SIGTERM')
      setTimeout(() => kill('SIGKILL'), 5_000).unref()
    }, options.timeoutMs)

    child.on('close', async (code) => {
      clearTimeout(timer)
      try {
        await rm(home, { recursive: true, force: true })
      } catch {
        // A directory that cannot be removed does not change what the command did.
      }
      // A cut may land inside a multi-byte character; drop the broken start rather than show it.
      const output = buffer.toString('utf8').replace(/^�+/, '')
      resolve({
        exitCode: timedOut ? null : code,
        timedOut,
        output,
        truncated,
        durationMs: Date.now() - started,
      })
    })
  })
}

/** What a run of the test command came to; `failed` is the only result that sends Build round. */
export type TestVerdict = 'passed' | 'failed' | 'timed_out' | 'not_run'

/** Decided in this order: `timedOut` first, never `exitCode === null` alone. */
export function classifyTestRun(run: Pick<TestRun, 'exitCode' | 'timedOut'>): TestVerdict {
  if (run.timedOut) return 'timed_out'
  if (run.exitCode === 0) return 'passed'
  if (run.exitCode !== null) return 'failed'
  return 'not_run'
}

const REPORT_CHARS = 20_000
const BLOCK_CHARS = 4_096

/** The report the next Build reads when the test command failed. */
export function testCommandReport(
  command: string,
  run: Pick<TestRun, 'exitCode' | 'output' | 'truncated'>,
): string {
  const cut = run.truncated || run.output.length > REPORT_CHARS
  return [
    'The test command failed, so nothing was verified.',
    '',
    `Command: \`${command}\``,
    `exit code: ${String(run.exitCode)}`,
    ...(cut ? ['[output cut to its end]'] : []),
    '',
    run.output.slice(-REPORT_CHARS),
    '',
    "Make the command pass and commit, changing only the plan's files.",
    "If the failure is not in the plan's files, say so in your summary and change nothing for it.",
    '',
  ].join('\n')
}

/** The text a Build reads when the report file is missing. */
export function testCommandReportFallback(command: string): string {
  return `The test command \`${command}\` failed, so nothing was verified. Make it pass and commit, changing only the plan's files. If the failure is not in the plan's files, say so in your summary and change nothing for it.`
}

/** The instruction that ends every block the test command's result makes. */
export function fixInstruction(o: { worktree: string; command: string; base: string }): string {
  return `In ${o.worktree}, make \`${o.command}\` pass and commit the fix, then Resume. A failure in a file outside the plan is fixed on the base branch instead: push the fix to \`origin/${o.base}\`, then Resume, and the tests stage rebases the branch onto it before the command runs. Only committed work is tested: Resume undoes uncommitted changes first, and a path outside the plan committed in the worktree fails the files gate, which ends the run on attempt 3.`
}

export const OUTSIDE_CAUSE =
  'If the cause was outside the code, for example the machine slept or the disk was full, Resume runs the command again as it is.'

/** The `output` of the block for a test command that failed on the last attempt. */
export function failedBlockOutput(
  run: Pick<TestRun, 'exitCode' | 'output'>,
  instruction: string,
): string {
  return [
    'the test command failed on attempt 3',
    `exit code: ${String(run.exitCode)}`,
    run.output.slice(-BLOCK_CHARS),
    instruction,
  ].join('\n')
}

/** The `output` of the block for a test command that timed out or did not run. */
export function notPassedBlockOutput(
  run: Pick<TestRun, 'timedOut' | 'output'>,
  instruction: string,
): string {
  return [
    run.timedOut
      ? 'the test command was killed after its timeout'
      : 'the test command did not run or was killed',
    run.output.slice(-BLOCK_CHARS),
    OUTSIDE_CAUSE,
    instruction,
  ].join('\n')
}

/** The `output` of the block for a Build that changed nothing after a failed test command. */
export function unchangedBlockOutput(instruction: string): string {
  return ['the build changed nothing after the test command failed', instruction].join('\n')
}
