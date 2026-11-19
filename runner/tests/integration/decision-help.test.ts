import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardApi } from '../../src/api.js'
import type { HelpWork } from '../../src/contract.js'
import { realExec } from '../../src/exec.js'
import { Git } from '../../src/git.js'
import type { ProcessInput, ProcessResult } from '../../src/phases/process.js'
import type { RunnerEvent } from '../../src/contract.js'
import {
  HELP_FILE,
  RESTART_REASON,
  carryHelp,
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

/** The processes `carryHelp` starts: each call is recorded, and a test scripts what it returns. */
const processes = vi.hoisted(() => ({
  calls: [] as { input: ProcessInput }[],
  script: null as null | ((input: ProcessInput, call: number) => Promise<unknown> | unknown),
}))
vi.mock('../../src/phases/process.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/phases/process.js')>()
  return {
    ...actual,
    runProcess: (input: ProcessInput, deps: Parameters<typeof actual.runProcess>[1]) => {
      processes.calls.push({ input })
      return processes.script === null
        ? actual.runProcess(input, deps)
        : processes.script(input, processes.calls.length)
    },
  }
})

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

// ── carryHelp's resume, with the process stubbed ─────────────────────────────────────────────

interface Shape {
  exit?: number
  error?: boolean
  text?: string
  stopped?: ProcessResult['stopped']
  interrupted?: boolean
  /** The process writes the marker the event hook writes when a save is accepted. */
  saves?: boolean
  cost?: Record<string, number>
  totals?: Record<string, unknown>
}
const NOT_SAVED = 'the helper ended without saving a result'
const ASKED_TO_SAVE = `${NOT_SAVED}, even when asked to save`

/** A question help carried with scripted processes, a stub board and the signals a row sets. */
async function carried(
  shapes: Shape[],
  options: {
    marker?: boolean
    heartbeat?: 'ok' | 'stop' | 'reject'
    signal?: { on: number; kind: 'restart' | 'shutdown' }
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'carry-home-'))
  mkdirSync(runPaths(home, 'run-1').worktree, { recursive: true })
  const runDir = join(home, 'helps', 'help-1')
  if (options.marker === true) {
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'help-saved'), '')
  }
  const restart = new AbortController()
  const shutdown = new AbortController()
  const sent: RunnerEvent[] = []
  const failed: string[] = []
  let heartbeats = 0
  const api = {
    helpHeartbeat: async () => {
      heartbeats += 1
      if (options.heartbeat === 'reject') throw new Error('unreachable')
      return { stop: options.heartbeat === 'stop' ? ['help-1'] : [] }
    },
    issueHelpToken: async () => 'token',
    sendEvents: async (_token: string, events: RunnerEvent[]) => {
      sent.push(...events)
      return events.length
    },
    failHelp: async (_id: string, reason: string) => void failed.push(reason),
    retire: async () => undefined,
  }
  processes.calls = []
  processes.script = (input, call) => {
    const shape = shapes[call - 1] ?? {}
    if (shape.saves === true) writeFileSync(join(input.runDir, 'help-saved'), '')
    if (options.signal?.on === call)
      (options.signal.kind === 'restart' ? restart : shutdown).abort()
    const totals = shape.totals ?? { opus: { input: call * 10 } }
    return {
      exitCode: shape.exit ?? 0,
      stopped: shape.stopped ?? 'no',
      interrupted: shape.interrupted ?? false,
      stderrTail: '',
      normalizer: {
        result: { isError: shape.error ?? false, text: shape.text ?? `text ${call}` },
        sessionId: 'session-from-process',
        totals: () => totals,
        reportedCost: () => shape.cost ?? { opus: call },
      },
    }
  }
  await carryHelp(
    {
      id: 'help-1',
      mode: 'suggest',
      decision: 'question',
      approval_id: null,
      question_index: null,
      phase_id: 'p',
      attempt: 1,
      run: {
        id: 'run-1',
        number: 1,
        worktree_path: null,
        task: { id: 't', key: 'PAY-1', title: 'T', budget_usd: null },
      },
    } as HelpWork,
    {
      api: api as unknown as BoardApi,
      git,
      config: {
        runnerId: 'r',
        heartbeatMs: 600_000,
        home,
        claudeBin: 'claude',
        boardUrl: 'http://b',
      } as never,
      runnerCode: 'code',
      shutdown: shutdown.signal,
      restart: restart.signal,
    },
  )
  processes.script = null
  return { calls: processes.calls.map((c) => c.input), sent, failed, heartbeats }
}

describe('carryHelp asks a helper that did not save once', () => {
  beforeEach(() => {
    processes.calls = []
  })
  const rows: {
    name: string
    shapes: Shape[]
    options?: Parameters<typeof carried>[1]
    launches: number
    heartbeats: number
    reason: string
  }[] = [
    {
      name: 'the first ends well without saving',
      shapes: [{}, {}],
      launches: 2,
      heartbeats: 1,
      reason: ASKED_TO_SAVE,
    },
    {
      name: 'the first saved',
      shapes: [{ saves: true }],
      launches: 1,
      heartbeats: 0,
      reason: NOT_SAVED,
    },
    {
      name: 'the resumed one saves',
      shapes: [{}, { saves: true }],
      launches: 2,
      heartbeats: 1,
      reason: NOT_SAVED,
    },
    {
      name: 'a marker from before is in the run directory',
      shapes: [{}, {}],
      options: { marker: true },
      launches: 2,
      heartbeats: 1,
      reason: ASKED_TO_SAVE,
    },
    {
      name: 'the first ends with an error result',
      shapes: [{ error: true }],
      launches: 1,
      heartbeats: 0,
      reason: 'the helper ended with an error',
    },
    {
      name: 'the first exits non-zero',
      shapes: [{ exit: 1 }],
      launches: 1,
      heartbeats: 0,
      reason: 'the helper ended with an error',
    },
    {
      name: 'the first was interrupted',
      shapes: [{ interrupted: true }],
      launches: 1,
      heartbeats: 0,
      reason: NOT_SAVED,
    },
    {
      name: 'the first was stopped by the board’s heartbeat',
      shapes: [{ stopped: 'cancelled' }],
      launches: 1,
      heartbeats: 0,
      reason: NOT_SAVED,
    },
    {
      name: 'restart is signalled',
      shapes: [{}],
      options: { signal: { on: 1, kind: 'restart' } },
      launches: 1,
      heartbeats: 0,
      reason: RESTART_REASON,
    },
    {
      name: 'shutdown is signalled',
      shapes: [{}],
      options: { signal: { on: 1, kind: 'shutdown' } },
      launches: 1,
      heartbeats: 0,
      reason: 'the runner stopped',
    },
    {
      name: 'the stop check’s list holds the help',
      shapes: [{}],
      options: { heartbeat: 'stop' },
      launches: 1,
      heartbeats: 1,
      reason: NOT_SAVED,
    },
    {
      name: 'the stop check fails',
      shapes: [{}],
      options: { heartbeat: 'reject' },
      launches: 1,
      heartbeats: 1,
      reason: NOT_SAVED,
    },
    {
      name: 'the resumed one ends with an error',
      shapes: [{}, { error: true }],
      launches: 2,
      heartbeats: 1,
      reason: 'the helper ended with an error',
    },
    {
      name: 'restart is signalled during the resumed one',
      shapes: [{}, {}],
      options: { signal: { on: 2, kind: 'restart' } },
      launches: 2,
      heartbeats: 1,
      reason: RESTART_REASON,
    },
  ]
  it.each(rows)('when $name', async ({ shapes, options, launches, heartbeats, reason }) => {
    const done = await carried(shapes, options)
    expect(done.calls).toHaveLength(launches)
    expect(done.heartbeats).toBe(heartbeats)
    expect(done.failed).toEqual([reason])
  })

  it('resumes the same session, with the first totals as its baseline and a message to save', async () => {
    const done = await carried([{ totals: { opus: { input: 7 } } }, {}])
    const [first, second] = done.calls
    expect(first).toMatchObject({ resume: false, baseline: {} })
    expect(second).toMatchObject({
      resume: true,
      sessionId: 'session-from-process',
      baseline: { opus: { input: 7 } },
      phase: 'help',
    })
    expect(second!.prompt).toContain('Nothing was saved')
    expect(second!.prompt).toContain('save_help_result')
  })

  it('sends one phase start and one closing phase end that sums the shares', async () => {
    const done = await carried([
      { text: 'the advice', cost: { opus: 1.5, haiku: 0.25 } },
      { text: '', cost: { opus: 0.5 }, interrupted: true },
    ])
    const types = done.sent.map((event) => event.type)
    expect(types.filter((type) => type === 'phase_start')).toHaveLength(1)
    expect(types.filter((type) => type === 'phase_end')).toHaveLength(1)
    expect(types.at(-1)).toBe('phase_end')
    expect(done.sent.at(-1)!.payload).toMatchObject({
      status: 'succeeded',
      // The resumed process wrote no text: the first one's stands.
      summary_md: 'the advice',
      reported_cost: { opus: 2, haiku: 0.25 },
      session_id: 'session-from-process',
      interrupted: true,
    })
  })
})
