import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { MigrationSiblings } from '../approvals/approval-rules.js'

const run = promisify(execFile)

/** Runs `git` with these arguments in `cwd` and returns its output; rejects when git fails. */
export type GitRun = (cwd: string, args: string[]) => Promise<string>

const defaultGit: GitRun = async (cwd, args) => (await run('git', ['-C', cwd, ...args])).stdout

/**
 * What a migration request is checked against: whether `path` exists in the run's worktree, and
 * the file names directly beside it, in the worktree and on `origin/<base>` as last fetched.
 * Either source that cannot be read is left out; nothing is fetched.
 */
export async function readMigrationSiblings(
  where: { worktreePath: string | null; repoPath: string; baseBranch: string },
  path: string,
  git: GitRun = defaultGit,
): Promise<MigrationSiblings> {
  const directory = dirname(path)
  const names = new Set<string>()
  let exists = false
  if (where.worktreePath !== null && !isAbsolute(path)) {
    exists = existsSync(join(where.worktreePath, path))
    try {
      for (const entry of await readdir(join(where.worktreePath, directory)))
        if ((await stat(join(where.worktreePath, directory, entry))).isFile()) names.add(entry)
    } catch {
      // The directory is not in the worktree.
    }
  }
  try {
    const out = await git(where.repoPath, ['ls-tree', `origin/${where.baseBranch}:${directory}`])
    for (const line of out.split('\n')) {
      const match = /^\d+ blob \S+\t(.+)$/.exec(line)
      if (match?.[1] !== undefined) names.add(match[1])
    }
  } catch {
    // `origin/<base>` does not resolve in the repository, or has no such directory.
  }
  return { exists, siblings: [...names] }
}
