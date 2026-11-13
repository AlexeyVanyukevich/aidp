import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { BoardApi } from '../../src/api.js'
import type { HelpWork } from '../../src/contract.js'
import { realExec } from '../../src/exec.js'
import { Git } from '../../src/git.js'
import {
  HELP_FILE,
  checkoutPayload,
  cleanUpHelp,
  clearEndedHelps,
  helpPrompt,
  prepareHelpCheckout,
} from '../../src/help.js'
import { readLinked } from '../../src/linked.js'
import { runPaths } from '../../src/run-steps.js'
import { LOG_FILE, type LogContext, type LogLine } from '../../src/worktree-log.js'
import { targetRepository, useTestGitIdentity } from './target-repo.js'

const sh = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const git = new Git(realExec, 'gh')
beforeAll(useTestGitIdentity)

const HELP_RUN = '33333333-3333-4333-8333-333333333333'
const PAUSED_RUN = '44444444-4444-4444-8444-444444444444'

function setup() {
  const project = targetRepository()
  const zlc = targetRepository()
  const home = mkdtempSync(join(tmpdir(), 'help-home-'))
  const link = {
    key: 'ZLC',
    name: 'Zellige',
    note: 'the kit',
    repo_path: zlc.repo,
    github_repo: 'owner/zellige',
    base_branch: 'main',
  }
  const removals: LogContext = { home, runId: HELP_RUN, clock: () => new Date(0) }
  const work = (
    checkout: NonNullable<HelpWork['decision_work']>['checkout'],
    links = [link],
  ): HelpWork => ({
    id: 'help-1',
    mode: 'check',
    decision: 'mark_done',
    subject: null,
    approval_id: null,
    question_index: null,
    decision_work: { repo_path: project.repo, base_branch: 'main', links, checkout },
    phase_id: 'p',
    attempt: 1,
    run: {
      id: HELP_RUN,
      number: 1,
      worktree_path: null,
      task: { id: 't', key: 'PAY-1', title: 'T', budget_usd: null },
    },
  })
  return { project, zlc, home, link, removals, work }
}

const log = (home: string): LogLine[] =>
  existsSync(join(home, LOG_FILE))
    ? readFileSync(join(home, LOG_FILE), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as LogLine)
    : []

describe('a decision help’s checkout', () => {
  it('reads the pull-request branch when it is on origin (AC13)', async () => {
    const { project, home, removals, work } = setup()
    sh(['checkout', '-q', '-b', 'board/PAY-1-r1'], project.repo)
    writeFileSync(join(project.repo, 'pr.txt'), 'pr\n')
    sh(['add', '-A'], project.repo)
    sh(['commit', '-q', '-m', 'pr'], project.repo)
    sh(['push', '-q', 'origin', 'board/PAY-1-r1'], project.repo)
    sh(['checkout', '-q', 'main'], project.repo)
    const made = await prepareHelpCheckout(
      work({ source: 'pr_branch', branch: 'board/PAY-1-r1' }),
      git,
      home,
      removals,
    )
    expect(made).toMatchObject({
      ref: 'origin/board/PAY-1-r1',
      source: 'pr_branch',
      fallback: false,
    })
    expect(existsSync(join(made.worktree, 'pr.txt'))).toBe(true)
    expect(helpPrompt(work({ source: 'base' }), made)).toContain(
      '<checkout ref="origin/board/PAY-1-r1" source="pr_branch"/>',
    )
    expect(readLinked(made.runDir).map((c) => c.key)).toEqual(['ZLC'])
    expect(JSON.parse(readFileSync(join(made.runDir, HELP_FILE), 'utf8'))).toEqual({
      repo_path: project.repo,
      made_worktree: true,
    })
  })

  it('reads origin/base when the branch is gone (AC14)', async () => {
    const { home, removals, work } = setup()
    const made = await prepareHelpCheckout(
      work({ source: 'pr_branch', branch: 'board/PAY-1-r9' }),
      git,
      home,
      removals,
    )
    expect(made).toMatchObject({ ref: 'origin/main', source: 'pr_branch', fallback: true })
  })

  it('fails with the checkout message when the worktree cannot be made (AC17)', async () => {
    const { project, home, removals, work } = setup()
    mkdirSync(join(home, 'worktrees', HELP_RUN), { recursive: true })
    writeFileSync(join(home, 'worktrees', HELP_RUN, 'in-the-way'), 'x')
    await expect(
      prepareHelpCheckout(work({ source: 'base' }), git, home, removals),
    ).rejects.toThrow(/worktree add|already exists/)
    expect(project.repo).toBeTruthy()
  })

  it('uses a paused run’s worktree, copies its links, and removes only its own directory (AC15, AC46)', async () => {
    const { project, home, removals, work } = setup()
    const paused = runPaths(home, PAUSED_RUN)
    sh(['worktree', 'add', '--detach', paused.worktree, 'origin/main'], project.repo)
    mkdirSync(join(paused.linked, 'ZLC'), { recursive: true })
    mkdirSync(paused.runDir, { recursive: true })
    const listed = [{ key: 'ZLC', repo_path: '/owner/zlc', path: join(paused.linked, 'ZLC') }]
    writeFileSync(join(paused.runDir, 'linked.json'), JSON.stringify(listed))
    const made = await prepareHelpCheckout(
      work({ source: 'paused_run', run_id: PAUSED_RUN }),
      git,
      home,
      removals,
    )
    expect(made).toMatchObject({ worktree: paused.worktree, madeWorktree: false })
    expect(readLinked(made.runDir)).toEqual(listed)
    expect(JSON.parse(readFileSync(join(made.runDir, HELP_FILE), 'utf8')).made_worktree).toBe(false)
    await cleanUpHelp(git, home, HELP_RUN)
    expect(existsSync(paused.worktree)).toBe(true)
    expect(existsSync(join(paused.linked, 'ZLC'))).toBe(true)
    expect(existsSync(made.runDir)).toBe(false)
    const lines = log(home).filter((line) => line.caller === 'help')
    expect(lines.map((line) => line.path)).toEqual([made.runDir])
  })

  it('makes a base worktree when the paused one is gone, and removes it all at the end (AC16)', async () => {
    const { home, removals, work } = setup()
    const made = await prepareHelpCheckout(
      work({ source: 'paused_run', run_id: PAUSED_RUN }),
      git,
      home,
      removals,
    )
    expect(made).toMatchObject({ ref: 'origin/main', madeWorktree: true, fallback: true })
    const { linked } = runPaths(home, HELP_RUN)
    expect(existsSync(join(linked, 'ZLC'))).toBe(true)
    await cleanUpHelp(git, home, HELP_RUN)
    for (const path of [made.worktree, linked, made.runDir]) expect(existsSync(path)).toBe(false)
    const lines = log(home).filter((line) => line.caller === 'help')
    expect(lines.length).toBeGreaterThanOrEqual(3)
    for (const line of lines) expect(['removed', 'deleted', 'absent']).toContain(line.result)
  })
})

describe('a pull request review’s checkout', () => {
  /** A branch with a changed file, a lockfile and a deleted file, pushed to origin. */
  function pushBranch(repo: string): void {
    sh(['checkout', '-q', '-b', 'feat/x'], repo)
    writeFileSync(join(repo, 'new file.txt'), 'one\ntwo\n')
    writeFileSync(join(repo, 'package-lock.json'), '{}\n')
    sh(['add', '-A'], repo)
    sh(['commit', '-q', '-m', 'pr'], repo)
    sh(['push', '-q', 'origin', 'feat/x'], repo)
    sh(['checkout', '-q', 'main'], repo)
  }

  it('reads origin/branch detached, writes pr.diff uncut and records the commit (AC9)', async () => {
    const { project, home, removals, work } = setup()
    pushBranch(project.repo)
    const made = await prepareHelpCheckout(
      work({ source: 'pull_request', branch: 'feat/x' }),
      git,
      home,
      removals,
    )
    expect(made).toMatchObject({ ref: 'origin/feat/x', source: 'pull_request', fallback: false })
    const head = sh(['rev-parse', 'HEAD'], made.worktree).trim()
    expect(made.commit).toBe(head)
    expect(head).toBe(sh(['rev-parse', 'origin/feat/x'], project.repo).trim())
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], made.worktree).trim()).toBe('HEAD')
    const expected = sh(['diff', '--no-renames', 'origin/main...origin/feat/x'], project.repo)
    expect(readFileSync(join(made.runDir, 'pr.diff'), 'utf8')).toBe(expected)
    expect(made.diff).toMatchObject({
      path: join(made.runDir, 'pr.diff'),
      bytes: Buffer.byteLength(expected),
      lines: expected.split('\n').length - 1,
    })
    expect(made.diff?.files.map((f) => [f.path, f.skip])).toEqual([
      ['new file.txt', undefined],
      ['package-lock.json', 'lockfile'],
    ])
    const text = helpPrompt(work({ source: 'base' }), made)
    expect(text).toContain(`<diff path="${join(made.runDir, 'pr.diff')}"`)
    expect(text).toContain('<file path="new file.txt" first_line="1"')
    expect(text).toContain('<linked_projects>')
  })

  it('fails when the branch is gone and makes no worktree (AC10)', async () => {
    const { home, removals, work } = setup()
    await expect(
      prepareHelpCheckout(
        work({ source: 'pull_request', branch: 'feat/gone' }),
        git,
        home,
        removals,
      ),
    ).rejects.toThrow('the branch `feat/gone` is not on origin')
    expect(existsSync(runPaths(home, HELP_RUN).worktree)).toBe(false)
  })

  it('removes the run directory, pr.diff and the worktree at the end (AC12)', async () => {
    const { project, home, removals, work } = setup()
    pushBranch(project.repo)
    const made = await prepareHelpCheckout(
      work({ source: 'pull_request', branch: 'feat/x' }),
      git,
      home,
      removals,
    )
    await cleanUpHelp(git, home, HELP_RUN)
    for (const path of [made.worktree, made.runDir, join(made.runDir, 'pr.diff')])
      expect(existsSync(path)).toBe(false)
    const paths = log(home)
      .filter((line) => line.caller === 'help')
      .map((line) => line.path)
    expect(paths).toContain(made.runDir)
    expect(paths).toContain(made.worktree)
  })

  it('records the HEAD of a paused run’s worktree, with a commit not on origin (AC35)', async () => {
    const { project, home, removals, work } = setup()
    const paused = runPaths(home, PAUSED_RUN)
    sh(['worktree', 'add', '--detach', paused.worktree, 'origin/main'], project.repo)
    writeFileSync(join(paused.worktree, 'local.txt'), 'x\n')
    sh(['add', '-A'], paused.worktree)
    sh(['commit', '-q', '-m', 'unpushed'], paused.worktree)
    writeFileSync(join(paused.worktree, 'uncommitted.txt'), 'y\n')
    mkdirSync(paused.runDir, { recursive: true })
    const made = await prepareHelpCheckout(
      work({ source: 'paused_run', run_id: PAUSED_RUN }),
      git,
      home,
      removals,
    )
    expect(made.ref).toBe(`worktree:${PAUSED_RUN}`)
    expect(made.commit).toBe(sh(['rev-parse', 'HEAD'], paused.worktree).trim())
  })

  it('records the skipped files in the checkout event’s payload', async () => {
    const { project, home, removals, work } = setup()
    pushBranch(project.repo)
    const made = await prepareHelpCheckout(
      work({ source: 'pull_request', branch: 'feat/x' }),
      git,
      home,
      removals,
    )
    expect(checkoutPayload(made)).toEqual({
      source: 'pull_request',
      fallback: false,
      commit: made.commit,
      skipped: [{ path: 'package-lock.json', skip: 'lockfile' }],
    })
  })

  // The owner's git config must not reach pr.diff: each row would change or break the diff.
  const configs: { name: string; key: string; value: string }[] = [
    { name: 'colour always', key: 'color.ui', value: 'always' },
    { name: 'an external diff that fails', key: 'diff.external', value: 'false' },
    { name: 'a textconv driver', key: 'diff.shout.textconv', value: 'sed s/one/ONE/' },
  ]
  it.each(configs)('writes the plain diff whatever the repository sets: $name', async (row) => {
    const { project, home, removals, work } = setup()
    sh(['checkout', '-q', '-b', 'feat/x'], project.repo)
    writeFileSync(join(project.repo, 'a.txt'), 'one\n')
    sh(['add', '-A'], project.repo)
    sh(['commit', '-q', '-m', 'pr'], project.repo)
    sh(['push', '-q', 'origin', 'feat/x'], project.repo)
    sh(['checkout', '-q', 'main'], project.repo)
    // Read whatever is checked out, so the textconv row's driver applies to the diff.
    writeFileSync(join(project.repo, '.git', 'info', 'attributes'), '*.txt diff=shout\n')
    const plain = sh(['diff', '--no-renames', 'origin/main...origin/feat/x'], project.repo)
    sh(['config', row.key, row.value], project.repo)
    // The row must change a plain `git diff`, or it proves nothing; a diff that fails changed it.
    const changed = () => {
      try {
        return sh(['diff', '--no-renames', 'origin/main...origin/feat/x'], project.repo) !== plain
      } catch {
        return true
      }
    }
    expect(changed()).toBe(true)
    const made = await prepareHelpCheckout(
      work({ source: 'pull_request', branch: 'feat/x' }),
      git,
      home,
      removals,
    )
    expect(readFileSync(join(made.runDir, 'pr.diff'), 'utf8')).toBe(plain)
    expect(made.diff?.files.map((f) => f.path)).toEqual(['a.txt'])
  })
})

describe('clearing leftovers at start', () => {
  const api = (answer: () => Promise<string[]>) =>
    ({ helpsEnded: async () => answer() }) as unknown as BoardApi

  it('removes only the ended help’s leftovers (AC39)', async () => {
    const { home, removals, work } = setup()
    const made = await prepareHelpCheckout(work({ source: 'base' }), git, home, removals)
    const queuedRun = '55555555-5555-4555-8555-555555555555'
    const queued = runPaths(home, queuedRun)
    mkdirSync(queued.runDir, { recursive: true })
    writeFileSync(
      join(queued.runDir, HELP_FILE),
      JSON.stringify({ repo_path: '/x', made_worktree: false }),
    )
    let asked: string[] = []
    const stub = {
      helpsEnded: async (ids: string[]) => {
        asked = ids
        return [HELP_RUN]
      },
    } as unknown as BoardApi
    await clearEndedHelps(stub, git, home)
    expect(asked.sort()).toEqual([HELP_RUN, queuedRun].sort())
    expect(existsSync(made.worktree)).toBe(false)
    expect(existsSync(made.runDir)).toBe(false)
    expect(existsSync(queued.runDir)).toBe(true)
    for (const line of log(home).filter((line) => line.caller === 'help'))
      expect(line.result).not.toBe('refused')
  })

  it('removes nothing when the board cannot be asked (AC47)', async () => {
    const { home, removals, work } = setup()
    const made = await prepareHelpCheckout(work({ source: 'base' }), git, home, removals)
    await clearEndedHelps(
      api(async () => {
        throw new Error('board down')
      }),
      git,
      home,
    )
    expect(existsSync(made.worktree)).toBe(true)
    expect(existsSync(made.runDir)).toBe(true)
    expect(log(home).filter((line) => line.caller === 'help')).toEqual([])
  })
})
