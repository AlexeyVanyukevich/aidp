import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
    await this.pruneWorktrees(repo)
    await this.run('git', ['-C', repo, 'worktree', 'add', '-b', branch, dir, `origin/${base}`])
  }

  /** A worktree on a branch that already exists, to bring a lost run's worktree back. */
  async addWorktreeOnBranch(repo: string, branch: string, dir: string): Promise<void> {
    await this.pruneWorktrees(repo)
    await this.run('git', ['-C', repo, 'worktree', 'add', dir, branch])
  }

  /** Whether the project's repository holds a local branch of this name. */
  async branchExists(repo: string, branch: string): Promise<boolean> {
    const result = await this.exec(
      'git',
      ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      {},
    )
    return result.code === 0
  }

  /** A spec run's checkout: the remote's base, detached, since a draft pushes nothing. */
  async prepareDetachedWorktree(repo: string, base: string, dir: string): Promise<void> {
    await this.run('git', ['-C', repo, 'fetch', 'origin', base])
    await this.pruneWorktrees(repo)
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
    const root = (await this.run('git', ['-C', dir, 'rev-parse', '--show-toplevel'])).trim()
    const list = async (args: string[]) =>
      (await this.run('git', ['-C', root, ...args])).split('\0').filter((p) => p !== '')
    const mergeBase = (
      await this.run('git', ['-C', root, 'merge-base', 'HEAD', `origin/${base}`])
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

  /**
   * A file's text at `HEAD`, or null when `HEAD` does not hold it. Paths are root-relative. Any
   * other failure is a `GitError`, so a broken repository is not read as a missing file.
   */
  async fileAtHead(dir: string, path: string): Promise<string | null> {
    const entry = await this.run('git', [
      '-C',
      dir,
      '--literal-pathspecs',
      'ls-tree',
      'HEAD',
      '--',
      path,
    ])
    if (entry === '') return null
    return this.run('git', ['-C', dir, 'show', `HEAD:${path}`])
  }

  /** The remote's current base, fetched into `origin/<base>` of the project's repository. */
  async fetchBase(repo: string, base: string): Promise<void> {
    await this.run('git', ['-C', repo, 'fetch', 'origin', base])
  }

  /**
   * Undoes every uncommitted path (staged, unstaged, untracked; never ignored): a path HEAD
   * tracks goes back to its content at HEAD, in the index and the working tree; a path HEAD
   * does not track is unstaged and deleted. Paths travel on stdin, NUL-separated, so a long
   * list never meets the argument limit and a name is taken literally.
   */
  async undoUncommitted(dir: string, base: string): Promise<void> {
    const { uncommitted } = await this.changedPaths(dir, base)
    if (uncommitted.length === 0) return
    const inHead = new Set(
      (await this.run('git', ['-C', dir, 'ls-tree', '-r', '-z', '--name-only', 'HEAD']))
        .split('\0')
        .filter((p) => p !== ''),
    )
    const tracked = uncommitted.filter((p) => inHead.has(p))
    const others = uncommitted.filter((p) => !inHead.has(p))
    const stdin = (paths: string[]) => paths.map((p) => `${p}\0`).join('')
    const literal = ['--literal-pathspecs', '-C', dir]
    if (tracked.length > 0)
      await this.run(
        'git',
        [
          ...literal,
          'restore',
          '--source=HEAD',
          '--staged',
          '--worktree',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        { input: stdin(tracked) },
      )
    if (others.length > 0) {
      await this.run(
        'git',
        [...literal, 'reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { input: stdin(others) },
      )
      for (const p of others) rmSync(join(dir, p), { recursive: true, force: true })
    }
  }

  /** Moves the run's branch to the fetched base; fails when the branch holds commits of its own. */
  async fastForward(dir: string, base: string): Promise<void> {
    await this.run('git', ['-C', dir, 'merge', '--ff-only', `origin/${base}`])
  }

  async commitCount(dir: string, from: string, to: string): Promise<number> {
    return Number(
      (await this.run('git', ['-C', dir, 'rev-list', '--count', `${from}..${to}`])).trim(),
    )
  }

  /** The paths that differ between two commits, sorted. */
  async changedBetween(dir: string, from: string, to: string): Promise<string[]> {
    const out = await this.run('git', [
      '-C',
      dir,
      'diff',
      '-z',
      '--name-only',
      '--no-renames',
      from,
      to,
    ])
    return [...new Set(out.split('\0').filter((p) => p !== ''))].sort()
  }

  /** The merge-base of HEAD and `origin/<base>`. */
  async mergeBase(dir: string, base: string): Promise<string> {
    return (await this.run('git', ['-C', dir, 'merge-base', 'HEAD', `origin/${base}`])).trim()
  }

  /** A ref's commit. */
  async revParse(dir: string, ref: string): Promise<string> {
    return (await this.run('git', ['-C', dir, 'rev-parse', '--verify', ref])).trim()
  }

  /** Whether `origin/<base>` is an ancestor of HEAD; any failure other than "no" is a `GitError`. */
  async baseIsAncestor(dir: string, base: string): Promise<boolean> {
    const args = ['-C', dir, 'merge-base', '--is-ancestor', `origin/${base}`, 'HEAD']
    const result = await this.exec('git', args, {})
    if (result.code === 0) return true
    if (result.code === 1) return false
    throw new GitError(`git ${args.join(' ')}`, (result.stderr || result.stdout).trim())
  }

  /** The paths a rebase or merge left unmerged, sorted. */
  async unmergedPaths(dir: string): Promise<string[]> {
    const out = await this.run('git', ['-C', dir, 'diff', '-z', '--name-only', '--diff-filter=U'])
    return [...new Set(out.split('\0').filter((p) => p !== ''))].sort()
  }

  /**
   * Rebases the branch onto `origin/<base>`. A conflict leaves the rebase in progress and returns
   * the unmerged paths; any other failure is a `GitError`.
   */
  async rebase(dir: string, base: string): Promise<{ conflicts: string[] }> {
    const args = ['-C', dir, 'rebase', `origin/${base}`]
    const result = await this.exec('git', args, {})
    if (result.code === 0) return { conflicts: [] }
    const conflicts = await this.unmergedPaths(dir).catch(() => [])
    if (conflicts.length > 0) return { conflicts }
    throw new GitError(`git ${args.join(' ')}`, (result.stderr || result.stdout).trim())
  }

  async rebaseAbort(dir: string): Promise<void> {
    await this.run('git', ['-C', dir, 'rebase', '--abort'])
  }

  /**
   * The rebase in progress for `branch` in this worktree, found through `git rev-parse
   * --git-path` (a linked worktree's `.git` is a file), or null.
   */
  async rebaseInProgress(dir: string, branch: string): Promise<{ onto: string } | null> {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const path = resolve(
        dir,
        (await this.run('git', ['-C', dir, 'rev-parse', '--git-path', name])).trim(),
      )
      const read = (file: string): string | null => {
        try {
          return readFileSync(join(path, file), 'utf8').trim()
        } catch {
          return null
        }
      }
      if (read('head-name') !== `refs/heads/${branch}`) continue
      const onto = read('onto')
      if (onto !== null) return { onto }
    }
    return null
  }

  /** The commits in `from..to`, newest first, each as the abbreviated sha git prints and its subject. */
  async logRange(
    dir: string,
    from: string,
    to: string,
  ): Promise<{ sha: string; subject: string }[]> {
    const out = await this.run('git', [
      '-C',
      dir,
      'log',
      '--abbrev-commit',
      '--format=%h%x09%s',
      `${from}..${to}`,
    ])
    return out
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => {
        const [sha = '', ...rest] = l.split('\t')
        return { sha, subject: rest.join('\t') }
      })
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
