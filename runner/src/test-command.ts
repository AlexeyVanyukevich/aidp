import { spawn } from 'node:child_process'

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
export function runTestCommand(
  command: string,
  cwd: string,
  options: { timeoutMs: number; maxBytes?: number },
): Promise<TestRun> {
  const maxBytes = options.maxBytes ?? 65_536
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
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

    child.on('close', (code) => {
      clearTimeout(timer)
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
