import { execFile } from 'node:child_process'

export type Exec = (
  cmd: string,
  args: string[],
  options?: { cwd?: string; input?: string; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>

/** Never rejects: a failing command is a result with a code, which callers decide about. */
export const realExec: Exec = (cmd, args, options = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ code, stdout, stderr: error !== null && stderr === '' ? error.message : stderr })
      },
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
