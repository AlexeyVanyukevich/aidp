import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { realExec } from '../../src/exec.js'
import { Git, GitError } from '../../src/git.js'
import { targetRepository, useTestGitIdentity } from './target-repo.js'

const FAKE_GH = join(import.meta.dirname, '../fake/fake-gh')
const git = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, encoding: 'utf8' })

beforeAll(useTestGitIdentity)

describe('Git', () => {
  it('takes a run from a fresh worktree to a pushed branch and a pull request', async () => {
    const { remote, repo } = targetRepository()
    const subject = new Git(realExec, FAKE_GH)
    const worktree = join(mkdtempSync(join(tmpdir(), 'wt-')), 'run')

    await subject.prepareWorktree(repo, 'main', 'board/PAY-1-r1', worktree)
    expect(readFileSync(join(worktree, 'src/retry.ts'), 'utf8')).toContain('delays')
    expect(await subject.newCommits(worktree, 'main')).toBe(0)

    writeFileSync(join(worktree, 'src/retry.ts'), 'export const delays = [1, 2, 4]\n')
    git(['commit', '-q', '-am', 'back off'], worktree)
    expect(await subject.newCommits(worktree, 'main')).toBe(1)
    expect(await subject.diff(worktree, 'main')).toContain('+export const delays = [1, 2, 4]')

    await subject.push(worktree, 'board/PAY-1-r1')
    expect(git(['ls-remote', remote, 'board/PAY-1-r1'])).toContain('refs/heads/board/PAY-1-r1')

    const log = join(tmpdir(), `gh-${Date.now()}.log`)
    process.env.FAKE_GH_LOG = log
    expect(
      await subject.createPr(worktree, {
        githubRepo: 'owner/pay',
        base: 'main',
        branch: 'board/PAY-1-r1',
        title: 'PAY-1: Retry',
        body: 'report',
      }),
    ).toEqual({ number: 7, url: 'https://github.com/owner/pay/pull/7' })
    expect(readFileSync(log, 'utf8')).toContain(
      'pr create --repo owner/pay --base main --head board/PAY-1-r1 --title PAY-1: Retry --body-file -',
    )

    await subject.removeWorktree(repo, worktree)
    expect(existsSync(worktree)).toBe(false)
  })

  it('names the command and its output when git fails', async () => {
    const subject = new Git(realExec, FAKE_GH)
    const error = await subject
      .prepareWorktree('/does/not/exist', 'main', 'b', join(tmpdir(), 'never'))
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).command).toBe('git -C /does/not/exist fetch origin main')
    expect((error as GitError).output).not.toBe('')
  })
})
