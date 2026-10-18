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

  async newCommits(dir: string, base: string): Promise<number> {
    return Number(
      (await this.run('git', ['-C', dir, 'rev-list', '--count', `origin/${base}..HEAD`])).trim(),
    )
  }

  diff(dir: string, base: string): Promise<string> {
    return this.run('git', ['-C', dir, 'diff', `origin/${base}...HEAD`])
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

  async removeWorktree(repo: string, dir: string): Promise<void> {
    await this.run('git', ['-C', repo, 'worktree', 'remove', '--force', dir])
  }
}
