import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { realExec } from '../../src/exec.js'
import { Git, GitError } from '../../src/git.js'
import { pushToMain, targetRepository, useTestGitIdentity } from './target-repo.js'

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

  // Slice 3 spec §5: a spec run reads the code and pushes nothing, so it needs no branch.
  it('checks out a spec run’s worktree at the remote’s base, with no branch', async () => {
    const { repo } = targetRepository()
    const subject = new Git(realExec, FAKE_GH)
    const worktree = join(mkdtempSync(join(tmpdir(), 'wt-')), 'draft')

    await subject.prepareDetachedWorktree(repo, 'main', worktree)

    expect(readFileSync(join(worktree, 'src/retry.ts'), 'utf8')).toContain('delays')
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], worktree).trim()).toBe('HEAD')
    expect(git(['branch', '--format=%(refname:short)'], repo).trim()).toBe('main')
    await subject.removeWorktree(repo, worktree)
    expect(existsSync(worktree)).toBe(false)
  })

  describe('stale registrations and existing branches', () => {
    type Add = (subject: Git, repo: string, dir: string) => Promise<void>
    const rows: { name: string; add: Add }[] = [
      {
        name: 'prepareWorktree',
        add: (g, repo, dir) => g.prepareWorktree(repo, 'main', 'board/X-r1', dir),
      },
      {
        name: 'prepareDetachedWorktree',
        add: (g, repo, dir) => g.prepareDetachedWorktree(repo, 'main', dir),
      },
      {
        name: 'addWorktreeOnBranch',
        add: async (g, repo, dir) => {
          git(['branch', 'board/X-r1', 'main'], repo)
          await g.addWorktreeOnBranch(repo, 'board/X-r1', dir)
        },
      },
    ]
    it.each(rows)(
      '$name succeeds where a deleted worktree is still registered',
      async ({ add }) => {
        const { repo } = targetRepository()
        const subject = new Git(realExec, FAKE_GH)
        const dir = join(mkdtempSync(join(tmpdir(), 'wt-')), 'run')
        git(['worktree', 'add', '--detach', dir, 'main'], repo)
        rmSync(dir, { recursive: true, force: true })

        await add(subject, repo, dir)

        expect(git(['worktree', 'list', '--porcelain'], repo)).toContain(realpathSync(dir))
        expect(existsSync(join(dir, 'src/retry.ts'))).toBe(true)
      },
    )

    it('answers whether a branch exists', async () => {
      const { repo } = targetRepository()
      const subject = new Git(realExec, FAKE_GH)
      git(['branch', 'board/X-r1', 'main'], repo)
      expect(await subject.branchExists(repo, 'board/X-r1')).toBe(true)
      expect(await subject.branchExists(repo, 'board/X-r2')).toBe(false)
    })
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

  describe('fileAtHead', () => {
    it('reads a committed file as stored, not the worktree copy, and gives null for a missing one', async () => {
      const { repo } = targetRepository()
      pushToMain(repo, { 'db/migrations/004_x.ts': 'export const x = 1\r\n' }, 'base files')
      const subject = new Git(realExec, FAKE_GH)
      const worktree = join(mkdtempSync(join(tmpdir(), 'wt-')), 'run')
      await subject.prepareWorktree(repo, 'main', 'board/PAY-1-r1', worktree)
      writeFileSync(join(worktree, 'db/migrations/004_x.ts'), 'changed\n')
      expect(await subject.fileAtHead(worktree, 'db/migrations/004_x.ts')).toBe(
        'export const x = 1\r\n',
      )
      expect(await subject.fileAtHead(worktree, 'db/migrations/009_none.ts')).toBeNull()
    })

    it('fails with a GitError when git cannot read HEAD, rather than calling the file missing', async () => {
      const subject = new Git(realExec, FAKE_GH)
      const error = await subject
        .fileAtHead(mkdtempSync(join(tmpdir(), 'not-a-repo-')), 'db/migrations/004_x.ts')
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(GitError)
    })
  })

  describe('changedPaths', () => {
    const fresh = async (base: Record<string, string>) => {
      const { repo } = targetRepository()
      pushToMain(repo, base, 'base files')
      const subject = new Git(realExec, FAKE_GH)
      const worktree = join(mkdtempSync(join(tmpdir(), 'wt-')), 'run')
      await subject.prepareWorktree(repo, 'main', 'board/PAY-1-r1', worktree)
      return { repo, subject, worktree }
    }
    const write = (dir: string, path: string, content: string) => {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), content)
    }

    it('lists the net committed paths and the uncommitted ones, unquoted, with the merge-base', async () => {
      const { subject, worktree } = await fresh({
        '.gitignore': 'e\n',
        a: '1\n',
        b: '1\n',
        c: '1\n',
        f: 'file f\n',
        h: '1\n',
        'docs/café.md': '1\n',
      })
      write(worktree, 'a', '2\n')
      write(worktree, 'docs/café.md', '2\n')
      git(['mv', 'f', 'g'], worktree)
      git(['rm', '-q', 'h'], worktree)
      git(['add', '-A'], worktree)
      git(['commit', '-q', '-m', 'work'], worktree)
      write(worktree, 'b', '2\n')
      git(['add', 'b'], worktree)
      write(worktree, 'c', '2\n')
      write(worktree, 'd', '1\n')
      write(worktree, 'notes/ünï "q".txt', '1\n')
      write(worktree, 'e', '1\n')

      const changed = await subject.changedPaths(worktree, 'main')

      expect(changed.mergeBase).toBe(git(['merge-base', 'HEAD', 'origin/main'], worktree).trim())
      expect(changed.mergeBase).toMatch(/^[0-9a-f]{40}$/)
      expect([...changed.committed].sort()).toEqual(['a', 'docs/café.md', 'f', 'g', 'h'])
      expect([...changed.uncommitted].sort()).toEqual(['b', 'c', 'd', 'notes/ünï "q".txt'])
    })

    it('AC2: gives the same result from a subdirectory as from the root', async () => {
      const { subject, worktree } = await fresh({ 'sub/tracked.ts': '1\n', 'top.ts': '1\n' })
      write(worktree, 'sub/tracked.ts', '2\n')
      write(worktree, 'sub/new.ts', '1\n')
      write(worktree, 'top.txt', '1\n')

      const fromSub = await subject.changedPaths(join(worktree, 'sub'), 'main')

      expect(fromSub.uncommitted).toEqual(['sub/new.ts', 'sub/tracked.ts', 'top.txt'])
      expect(fromSub).toEqual(await subject.changedPaths(worktree, 'main'))
    })

    it('leaves out a path a later commit restores and a path only the base moved', async () => {
      const { repo, subject, worktree } = await fresh({ x: '1\n', y: '1\n' })
      write(worktree, 'x', '2\n')
      git(['commit', '-q', '-am', 'change x'], worktree)
      write(worktree, 'x', '1\n')
      git(['commit', '-q', '-am', 'restore x'], worktree)
      pushToMain(repo, { y: '2\n' }, 'base moves')
      git(['fetch', '-q', 'origin', 'main'], worktree)

      const changed = await subject.changedPaths(worktree, 'main')

      expect(changed.committed).toEqual([])
      expect(changed.uncommitted).toEqual([])
    })

    it('rejects with a GitError when origin/<base> does not exist', async () => {
      const { subject, worktree } = await fresh({ k: '1\n' })
      const error = await subject.changedPaths(worktree, 'nope').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(GitError)
    })
  })

  describe('rebasing a run onto the current base', () => {
    const subject = new Git(realExec, FAKE_GH)
    const branch = 'board/PAY-1-r1'
    const fresh = async () => {
      const { repo } = targetRepository()
      const worktree = join(mkdtempSync(join(tmpdir(), 'wt-')), 'run')
      await subject.prepareWorktree(repo, 'main', branch, worktree)
      return { repo, worktree }
    }
    const commit = (dir: string, file: string, content: string) => {
      writeFileSync(join(dir, file), content)
      git(['add', '-A'], dir)
      git(['commit', '-q', '-m', `edit ${file}`], dir)
    }

    it('AC10: a clean rebase moves the branch onto the new base', async () => {
      const { repo, worktree } = await fresh()
      commit(worktree, 'own.txt', 'mine\n')
      pushToMain(repo, { 'other.txt': 'theirs\n' }, 'base moves')
      await subject.fetchBase(repo, 'main')
      expect(await subject.baseIsAncestor(worktree, 'main')).toBe(false)
      const before = await subject.mergeBase(worktree, 'main')

      expect(await subject.rebase(worktree, 'main')).toEqual({ conflicts: [] })

      expect(await subject.baseIsAncestor(worktree, 'main')).toBe(true)
      expect(await subject.mergeBase(worktree, 'main')).toBe(
        await subject.revParse(worktree, 'origin/main'),
      )
      expect(await subject.mergeBase(worktree, 'main')).not.toBe(before)
      expect(await subject.newCommits(worktree, 'main')).toBe(1)
      expect(await subject.logRange(worktree, before, 'origin/main')).toEqual([
        { sha: expect.stringMatching(/^[0-9a-f]{7,}$/), subject: 'base moves' },
      ])
    })

    it('AC10: a conflicting rebase reports its paths and, once aborted, leaves HEAD where it was', async () => {
      const { repo, worktree } = await fresh()
      commit(worktree, 'src/retry.ts', 'mine\n')
      const head = await subject.head(worktree)
      pushToMain(repo, { 'src/retry.ts': 'theirs\n' }, 'base edits it')
      await subject.fetchBase(repo, 'main')

      const result = await subject.rebase(worktree, 'main')

      expect(result).toEqual({ conflicts: ['src/retry.ts'] })
      const found = await subject.rebaseInProgress(worktree, branch)
      expect(found).toEqual({ onto: await subject.revParse(worktree, 'origin/main') })
      expect(await subject.rebaseInProgress(worktree, 'board/OTHER-r1')).toBeNull()
      expect(await subject.unmergedPaths(worktree)).toEqual(['src/retry.ts'])

      await subject.rebaseAbort(worktree)

      expect(await subject.head(worktree)).toBe(head)
      expect(await subject.currentBranch(worktree)).toBe(branch)
      expect(await subject.rebaseInProgress(worktree, branch)).toBeNull()
    })

    it('reports no rebase in a worktree that has none, and throws a GitError for a bad base', async () => {
      const { worktree } = await fresh()
      expect(await subject.rebaseInProgress(worktree, branch)).toBeNull()
      await expect(subject.rebase(worktree, 'nope')).rejects.toBeInstanceOf(GitError)
      await expect(subject.baseIsAncestor(worktree, 'nope')).rejects.toBeInstanceOf(GitError)
    })
  })

  describe('refreshing a run to the current base', () => {
    const subject = new Git(realExec, FAKE_GH)
    const fresh = async () => {
      const { repo } = targetRepository()
      const worktree = join(mkdtempSync(join(tmpdir(), 'wt-')), 'run')
      await subject.prepareWorktree(repo, 'main', 'board/PAY-1-r1', worktree)
      return { repo, worktree }
    }

    it('AC4: undoes a changed, a staged and an untracked path, so the fast-forward succeeds', async () => {
      const { repo, worktree } = await fresh()
      writeFileSync(join(worktree, 'src/retry.ts'), 'setup changed\n')
      writeFileSync(join(worktree, 'staged.txt'), 'setup staged\n')
      git(['add', 'staged.txt'], worktree)
      writeFileSync(join(worktree, 'lock.json'), 'setup untracked\n')
      const before = git(['rev-parse', 'HEAD'], worktree).trim()

      pushToMain(
        repo,
        { 'src/retry.ts': 'new\n', 'staged.txt': 'base staged\n', 'lock.json': 'base lock\n' },
        'base moves',
      )
      await subject.fetchBase(repo, 'main')
      await subject.undoUncommitted(worktree, 'main')
      expect(readFileSync(join(worktree, 'src/retry.ts'), 'utf8')).toBe(
        'export const delays = []\n',
      )
      expect(existsSync(join(worktree, 'staged.txt'))).toBe(false)
      expect(existsSync(join(worktree, 'lock.json'))).toBe(false)
      expect(git(['status', '--porcelain'], worktree)).toBe('')

      await subject.fastForward(worktree, 'main')
      const after = git(['rev-parse', 'HEAD'], worktree).trim()
      expect(after).toBe(git(['rev-parse', 'origin/main'], repo).trim())
      expect(await subject.commitCount(worktree, before, after)).toBe(1)
      expect(await subject.changedBetween(worktree, before, after)).toEqual([
        'lock.json',
        'src/retry.ts',
        'staged.txt',
      ])
    })

    it('AC5: deletes an untracked file a failed setup left, then fast-forwards over a file of that name', async () => {
      const { repo, worktree } = await fresh()
      writeFileSync(join(worktree, 'generated.txt'), 'half-made\n')
      pushToMain(repo, { 'generated.txt': 'from base\n' }, 'base adds it')
      await subject.fetchBase(repo, 'main')
      await expect(subject.fastForward(worktree, 'main')).rejects.toBeInstanceOf(GitError)
      await subject.undoUncommitted(worktree, 'main')
      await subject.fastForward(worktree, 'main')
      expect(readFileSync(join(worktree, 'generated.txt'), 'utf8')).toBe('from base\n')
    })

    it('takes thousands of paths and odd names through stdin, and leaves ignored files', async () => {
      const { worktree } = await fresh()
      writeFileSync(join(worktree, '.gitignore'), 'node_modules/\n')
      git(['add', '.gitignore'], worktree)
      git(['commit', '-q', '-m', 'ignore'], worktree)
      mkdirSync(join(worktree, 'node_modules'))
      writeFileSync(join(worktree, 'node_modules/keep.js'), 'x')
      mkdirSync(join(worktree, 'many'))
      for (let i = 0; i < 3000; i += 1)
        writeFileSync(join(worktree, 'many', `${'long-name-'.repeat(8)}${i}.txt`), 'x')
      writeFileSync(join(worktree, '*.glob'), 'x')
      writeFileSync(join(worktree, 'a file.txt'), 'x')
      await subject.undoUncommitted(worktree, 'main')
      expect(existsSync(join(worktree, 'many', `${'long-name-'.repeat(8)}0.txt`))).toBe(false)
      expect(existsSync(join(worktree, '*.glob'))).toBe(false)
      expect(existsSync(join(worktree, 'a file.txt'))).toBe(false)
      expect(existsSync(join(worktree, 'node_modules/keep.js'))).toBe(true)
    })

    it('AC6: a fast-forward fails when the branch holds a commit of its own', async () => {
      const { repo, worktree } = await fresh()
      writeFileSync(join(worktree, 'own.txt'), 'x')
      git(['add', '-A'], worktree)
      git(['commit', '-q', '-m', 'own'], worktree)
      pushToMain(repo, { 'other.txt': 'y' }, 'base moves')
      await subject.fetchBase(repo, 'main')
      await expect(subject.fastForward(worktree, 'main')).rejects.toMatchObject({
        command: 'git -C ' + worktree + ' merge --ff-only origin/main',
      })
    })
  })
})
