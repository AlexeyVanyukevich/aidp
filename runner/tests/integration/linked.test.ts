import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { realExec } from '../../src/exec.js'
import { Git, GitError } from '../../src/git.js'
import { prepareLinked, readLinked, removeLinked, restoreLinked } from '../../src/linked.js'
import { targetRepository, useTestGitIdentity } from './target-repo.js'

const git = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const subject = new Git(realExec, 'gh')

beforeAll(useTestGitIdentity)

function setup() {
  const zlc = targetRepository()
  const root = mkdtempSync(join(tmpdir(), 'linked-'))
  const dir = join(root, 'worktrees', 'run-1-linked')
  const runDir = join(root, 'runs', 'run-1')
  mkdirSync(runDir, { recursive: true })
  const link = {
    key: 'ZLC',
    name: 'Zellige',
    note: 'the kit',
    repo_path: zlc.repo,
    github_repo: 'owner/zellige',
    base_branch: 'main',
  }
  return { zlc, dir, runDir, link, checkout: join(dir, 'ZLC') }
}

describe('linked checkouts', () => {
  it('makes a detached worktree of origin/base, lists it, and leaves the project alone', async () => {
    const { zlc, dir, runDir, link, checkout } = setup()
    const branches = git(['branch', '--list'], zlc.repo)
    const head = git(['rev-parse', 'HEAD'], zlc.repo)

    await prepareLinked(subject, [link], dir, runDir)

    expect(readFileSync(join(checkout, 'src/retry.ts'), 'utf8')).toContain('delays')
    expect(git(['rev-parse', 'HEAD'], checkout)).toBe(git(['rev-parse', 'origin/main'], zlc.repo))
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], checkout).trim()).toBe('HEAD')
    expect(readLinked(runDir)).toEqual([{ ...link, path: checkout }])
    expect(git(['worktree', 'list'], zlc.repo)).toContain(checkout)
    expect(git(['branch', '--list'], zlc.repo)).toBe(branches)
    expect(git(['rev-parse', 'HEAD'], zlc.repo)).toBe(head)
  })

  it('blocks as a git error, with the command and output, when the fetch fails', async () => {
    const { dir, runDir, link } = setup()
    const error = await prepareLinked(
      subject,
      [{ ...link, base_branch: 'no-such-branch' }],
      dir,
      runDir,
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).command).toContain('fetch origin no-such-branch')
    expect((error as GitError).output).not.toBe('')
  })

  it('removes the checkout and its directory, and git forgets it', async () => {
    const { zlc, dir, runDir, link, checkout } = setup()
    await prepareLinked(subject, [link], dir, runDir)

    await removeLinked(subject, dir, runDir)

    expect(existsSync(checkout)).toBe(false)
    expect(existsSync(dir)).toBe(false)
    expect(git(['worktree', 'list'], zlc.repo)).not.toContain(checkout)
  })

  it('makes a deleted checkout again on resume, and leaves one that is there', async () => {
    const { dir, runDir, link, checkout } = setup()
    await prepareLinked(subject, [link], dir, runDir)
    await restoreLinked(subject, runDir)
    expect(existsSync(checkout)).toBe(true)

    rmSync(checkout, { recursive: true, force: true })
    await restoreLinked(subject, runDir)

    expect(readFileSync(join(checkout, 'src/retry.ts'), 'utf8')).toContain('delays')
  })

  it('does nothing for a run with no links', async () => {
    const { dir, runDir } = setup()
    await prepareLinked(subject, [], dir, runDir)
    expect(readLinked(runDir)).toEqual([])
    expect(existsSync(dir)).toBe(false)
  })
})
