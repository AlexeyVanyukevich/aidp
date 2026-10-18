import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface RepoInspector {
  inspect(path: string): Promise<{ isGitRepo: boolean; remotes: string[] }>
  /** Whether the first word of `command` resolves to something runnable from `cwd`. */
  commandExists(command: string, cwd: string): Promise<boolean>
}

const GITHUB = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i

export function matchesGithubRepo(remotes: string[], repo: string): boolean {
  const wanted = repo.toLowerCase()
  return remotes.some((remote) => {
    const match = GITHUB.exec(remote.trim())
    return match !== null && `${match[1]}/${match[2]}`.toLowerCase() === wanted
  })
}

export function createRepoInspector(): RepoInspector {
  return {
    async inspect(path) {
      try {
        const inside = await run('git', ['-C', path, 'rev-parse', '--is-inside-work-tree'])
        if (inside.stdout.trim() !== 'true') return { isGitRepo: false, remotes: [] }
        const { stdout } = await run('git', ['-C', path, 'remote', '-v'])
        const remotes = stdout
          .split('\n')
          .map((line) => line.split(/\s+/)[1])
          .filter((url): url is string => url !== undefined && url !== '')
        return { isGitRepo: true, remotes: [...new Set(remotes)] }
      } catch {
        return { isGitRepo: false, remotes: [] }
      }
    },
    async commandExists(command, cwd) {
      const first = command.trim().split(/\s+/)[0]
      if (first === undefined || first === '') return false
      try {
        // `command -v` through a shell, so builtins, PATH lookups and ./scripts all resolve the
        // way they will when the runner runs the command.
        await run('sh', ['-c', 'command -v "$1"', 'sh', first], { cwd })
        return true
      } catch {
        return false
      }
    },
  }
}
