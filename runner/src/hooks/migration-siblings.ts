import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Runs `git` with these arguments in `cwd` and returns its output; throws when git fails. */
export type GitRun = (cwd: string, args: string[]) => string

const defaultGit: GitRun = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })

/**
 * The files directly in a migrations directory: those in the worktree and those on
 * `origin/<base>` as last fetched, each once. Either source that cannot be read is left out;
 * nothing is fetched.
 */
export function readMigrationSiblings(
  worktree: string,
  baseBranch: string | null,
  directory: string,
  git: GitRun = defaultGit,
): string[] {
  const names = new Set<string>()
  try {
    for (const entry of readdirSync(join(worktree, directory)))
      if (statSync(join(worktree, directory, entry)).isFile()) names.add(entry)
  } catch {
    // The directory is not in the worktree.
  }
  if (baseBranch !== null && baseBranch !== '') {
    try {
      const out = git(worktree, ['ls-tree', `origin/${baseBranch}:${directory}`])
      for (const line of out.split('\n')) {
        const match = /^\d+ blob \S+\t(.+)$/.exec(line)
        if (match?.[1] !== undefined) names.add(match[1])
      }
    } catch {
      // `origin/<base>` does not resolve here, or has no such directory.
    }
  }
  return [...names]
}
