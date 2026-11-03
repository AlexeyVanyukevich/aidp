import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { realExec } from '../../src/exec.js'
import { Git, GitError } from '../../src/git.js'
import { prepareLinked, readLinked, removeLinked, restoreLinked } from '../../src/linked.js'
import { LOG_FILE, type LogContext } from '../../src/worktree-log.js'
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
  const ctx: LogContext = { home: root, runId: 'run-1', clock: () => new Date(0) }
  return { zlc, root, ctx, dir, runDir, link, checkout: join(dir, 'ZLC') }
}

describe('linked checkouts', () => {
  it('makes a detached worktree of origin/base, lists it, and leaves the project alone', async () => {
    const { zlc, ctx, dir, runDir, link, checkout } = setup()
    const branches = git(['branch', '--list'], zlc.repo)
    const head = git(['rev-parse', 'HEAD'], zlc.repo)

    await prepareLinked(subject, [link], dir, runDir, ctx)

    expect(readFileSync(join(checkout, 'src/retry.ts'), 'utf8')).toContain('delays')
    expect(git(['rev-parse', 'HEAD'], checkout)).toBe(git(['rev-parse', 'origin/main'], zlc.repo))
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], checkout).trim()).toBe('HEAD')
    expect(readLinked(runDir)).toEqual([{ ...link, path: checkout }])
    expect(git(['worktree', 'list'], zlc.repo)).toContain(checkout)
    expect(git(['branch', '--list'], zlc.repo)).toBe(branches)
    expect(git(['rev-parse', 'HEAD'], zlc.repo)).toBe(head)
  })

  it('blocks as a git error, with the command and output, when the fetch fails', async () => {
    const { ctx, dir, runDir, link } = setup()
    const error = await prepareLinked(
      subject,
      [{ ...link, base_branch: 'no-such-branch' }],
      dir,
      runDir,
      ctx,
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).command).toContain('fetch origin no-such-branch')
    expect((error as GitError).output).not.toBe('')
  })

  it('removes the checkout and its directory, and git forgets it', async () => {
    const { zlc, ctx, dir, runDir, link, checkout } = setup()
    await prepareLinked(subject, [link], dir, runDir, ctx)

    await removeLinked(subject, dir, runDir, ctx, 'run_end')

    expect(existsSync(checkout)).toBe(false)
    expect(existsSync(dir)).toBe(false)
    expect(git(['worktree', 'list'], zlc.repo)).not.toContain(checkout)
  })

  it('makes a deleted checkout again on resume, and leaves one that is there', async () => {
    const { ctx, dir, runDir, link, checkout } = setup()
    await prepareLinked(subject, [link], dir, runDir, ctx)
    await restoreLinked(subject, runDir)
    expect(existsSync(checkout)).toBe(true)

    rmSync(checkout, { recursive: true, force: true })
    await restoreLinked(subject, runDir)

    expect(readFileSync(join(checkout, 'src/retry.ts'), 'utf8')).toContain('delays')
  })

  it('does nothing for a run with no links', async () => {
    const { ctx, dir, runDir } = setup()
    await prepareLinked(subject, [], dir, runDir, ctx)
    expect(readLinked(runDir)).toEqual([])
    expect(existsSync(dir)).toBe(false)
  })

  it('refuses a listed path outside the run’s -linked directory, and logs it', async () => {
    const { ctx, root, dir, runDir, link } = setup()
    const outside = join(root, 'precious')
    mkdirSync(outside)
    writeFileSync(join(runDir, 'linked.json'), JSON.stringify([{ ...link, path: outside }]))
    let removed = 0
    const counting = {
      removeWorktree: async () => {
        removed += 1
      },
      pruneWorktrees: async () => undefined,
    } as unknown as Git

    await removeLinked(counting, dir, runDir, ctx, 'run_end')

    expect(removed).toBe(0)
    expect(existsSync(outside)).toBe(true)
    const lines = readFileSync(join(root, LOG_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { result: string; path: string })
    expect(lines.find((l) => l.path === outside)?.result).toBe('refused')
  })
})
