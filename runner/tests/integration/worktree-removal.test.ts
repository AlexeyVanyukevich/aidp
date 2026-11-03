import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { RunWork } from '../../src/contract.js'
import { realExec } from '../../src/exec.js'
import { Git } from '../../src/git.js'
import { runPaths, runSteps, type RunDeps } from '../../src/run-steps.js'
import { LOG_FILE, type LogLine } from '../../src/worktree-log.js'
import { targetRepository, useTestGitIdentity } from './target-repo.js'

const git = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const RUN = { id: '33333333-3333-4333-8333-333333333333' } as RunWork

beforeAll(useTestGitIdentity)

describe('a run that ends, with its home reached through a symlink', () => {
  it('AC17: removes the real worktree from disk and from git, and logs it', async () => {
    const { repo } = targetRepository()
    const root = mkdtempSync(join(tmpdir(), 'removal-'))
    const realHome = join(root, 'real-home')
    const link = join(root, 'link-home')
    mkdirSync(realHome)
    symlinkSync(realHome, link)
    const { worktree, runDir } = runPaths(link, RUN.id)
    const subject = new Git(realExec, 'gh')
    await subject.prepareWorktree(repo, 'main', 'board/X-r1', worktree)
    expect(git(['worktree', 'list', '--porcelain'], repo)).toContain(realpathSync(worktree))

    const deps = {
      api: { issueToken: async () => 't' },
      git: subject,
      sink: { send: async () => undefined },
      setToken: () => undefined,
      config: { home: link },
      clock: () => new Date('2026-11-03T10:00:00.000Z'),
    } as unknown as RunDeps
    const steps = runSteps({ kind: 'start', run: RUN }, deps, { worktree, runDir, budgetUsd: null })
    await steps.carry(
      { repo, branch: null },
      async () => ({ outcome: 'review', extra: {} }) as never,
    )

    expect(existsSync(worktree)).toBe(false)
    expect(git(['worktree', 'list', '--porcelain'], repo)).not.toContain('board/X-r1')
    const lines = readFileSync(join(link, LOG_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as LogLine)
    const line = lines.find((l) => l.caller === 'run_end' && l.action === 'remove')
    expect(line).toMatchObject({ result: 'removed', path: worktree })
    expect(line?.resolved).toBe(join(realpathSync(realHome), 'worktrees', RUN.id))
  })
})
