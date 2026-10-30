import type { Exec } from './exec.js'

export class GitError extends Error {
  constructor(
    readonly command: string,
    readonly output: string,
  ) {
    super(`${command} failed: ${output}`)
  }
}

export class Git {
  constructor(
    private readonly exec: Exec,
    private readonly ghBin: string,
  ) {}

  private async run(
    cmd: string,
    args: string[],
    options: { cwd?: string; input?: string } = {},
  ): Promise<string> {
    const result = await this.exec(cmd, args, options)
    if (result.code !== 0)
      throw new GitError(
        `${cmd === this.ghBin ? 'gh' : cmd} ${args.join(' ')}`,
        (result.stderr || result.stdout).trim(),
      )
    return result.stdout
  }

  /** A new branch from the remote's base, so the run never starts from local, unpushed work. */
  async prepareWorktree(repo: string, base: string, branch: string, dir: string): Promise<void> {
    await this.run('git', ['-C', repo, 'fetch', 'origin', base])
    await this.run('git', ['-C', repo, 'worktree', 'add', '-b', branch, dir, `origin/${base}`])
  }

  /** A spec run's checkout: the remote's base, detached, since a draft pushes nothing. */
  async prepareDetachedWorktree(repo: string, base: string, dir: string): Promise<void> {
    await this.run('git', ['-C', repo, 'fetch', 'origin', base])
    await this.run('git', ['-C', repo, 'worktree', 'add', '--detach', dir, `origin/${base}`])
  }

  async newCommits(dir: string, base: string): Promise<number> {
    return Number(
      (await this.run('git', ['-C', dir, 'rev-list', '--count', `origin/${base}..HEAD`])).trim(),
    )
  }

  diff(dir: string, base: string): Promise<string> {
    return this.run('git', ['-C', dir, 'diff', `origin/${base}...HEAD`])
  }

  /**
   * What the branch changed, as paths relative to the worktree root: `committed` is the net
   * difference from the merge-base with `origin/<base>`; `uncommitted` is staged, unstaged and
   * untracked (never ignored) paths. Every listing runs with `-z`, so a path comes back exactly
   * as stored, never quoted.
   */
  async changedPaths(
    dir: string,
    base: string,
  ): Promise<{ mergeBase: string; committed: string[]; uncommitted: string[] }> {
    const list = async (args: string[]) =>
      (await this.run('git', ['-C', dir, ...args])).split('\0').filter((p) => p !== '')
    const mergeBase = (
      await this.run('git', ['-C', dir, 'merge-base', 'HEAD', `origin/${base}`])
    ).trim()
    const committed = await list(['diff', '-z', '--name-only', '--no-renames', mergeBase, 'HEAD'])
    const tracked = await list(['diff', '-z', '--name-only', '--no-renames', 'HEAD'])
    const untracked = await list(['ls-files', '-z', '--others', '--exclude-standard'])
    return {
      mergeBase,
      committed: [...new Set(committed)].sort(),
      uncommitted: [...new Set([...tracked, ...untracked])].sort(),
    }
  }

  async push(dir: string, branch: string): Promise<void> {
    await this.run('git', ['-C', dir, 'push', '-u', 'origin', branch])
  }

  async createPr(
    dir: string,
    pr: { githubRepo: string; base: string; branch: string; title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    const out = await this.run(
      this.ghBin,
      [
        'pr',
        'create',
        '--repo',
        pr.githubRepo,
        '--base',
        pr.base,
        '--head',
        pr.branch,
        '--title',
        pr.title,
        '--body-file',
        '-',
      ],
      { cwd: dir, input: pr.body },
    )
    const url = out.trim().split('\n').at(-1) ?? ''
    const match = /\/pull\/(\d+)$/.exec(url)
    if (match?.[1] === undefined)
      throw new GitError('gh pr create', `no pull request URL in: ${out.trim()}`)
    return { number: Number(match[1]), url }
  }

  async head(dir: string): Promise<string> {
    return (await this.run('git', ['-C', dir, 'rev-parse', 'HEAD'])).trim()
  }

  async currentBranch(dir: string): Promise<string> {
    return (await this.run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  }

  /** A run's own branch, so a resumed `prepare` can create it afresh. */
  async deleteBranch(repo: string, branch: string): Promise<void> {
    await this.run('git', ['-C', repo, 'branch', '-D', branch])
  }

  /** The open pull request for `branch`, if a run that stopped after `gh pr create` left one. */
  async findPr(
    dir: string,
    pr: { githubRepo: string; branch: string },
  ): Promise<{ number: number; url: string } | null> {
    const out = await this.run(
      this.ghBin,
      [
        'pr',
        'list',
        '--repo',
        pr.githubRepo,
        '--head',
        pr.branch,
        '--state',
        'open',
        '--json',
        'number,url',
      ],
      { cwd: dir },
    )
    const [open] = JSON.parse(out) as { number: number; url: string }[]
    return open ?? null
  }

  async removeWorktree(repo: string, dir: string): Promise<void> {
    await this.run('git', ['-C', repo, 'worktree', 'remove', '--force', dir])
  }

  /** Forgets worktrees whose directory is gone, so one can be made again at the same path. */
  async pruneWorktrees(repo: string): Promise<void> {
    await this.run('git', ['-C', repo, 'worktree', 'prune'])
  }
}
