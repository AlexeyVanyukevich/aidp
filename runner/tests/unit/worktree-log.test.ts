import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitError, type Git } from '../../src/git.js'
import {
  LOG_FILE,
  canonicalPath,
  deleteDirectory,
  guardPath,
  guardRunDir,
  recordLine,
  removeCheckout,
  type LogLine,
  type RemovalCaller,
} from '../../src/worktree-log.js'

const RUN = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-11-03T10:00:00.000Z')
const clock = () => NOW

interface Fixture {
  root: string
  real: string
  home: string
  link: string
  outside: string
}

/** Real directories under the temp directory, which is a symlink itself on macOS. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'guard-'))
  const real = realpathSync(root)
  const home = join(root, 'real-home')
  const link = join(root, 'link-home')
  const outside = join(root, 'outside')
  mkdirSync(join(home, 'worktrees', RUN), { recursive: true })
  mkdirSync(join(home, 'worktrees', OTHER))
  mkdirSync(join(home, 'runs', RUN), { recursive: true })
  mkdirSync(join(home, 'worktrees', `${RUN}-linked`, 'ZLC', 'deep'), { recursive: true })
  mkdirSync(outside)
  symlinkSync(home, link)
  symlinkSync(outside, join(home, 'worktrees', `${RUN}-linked`, 'EVIL'))
  symlinkSync(join(root, 'loop-b'), join(root, 'loop-a'))
  symlinkSync(join(root, 'loop-a'), join(root, 'loop-b'))
  return { root, real, home, link, outside }
}

interface GuardRow {
  name: string
  home: (f: Fixture) => string
  path: (f: Fixture) => string
  runId?: string
  /** The canonical path of a passing row; null when the row is refused. */
  expected: (f: Fixture) => string | null
}

const GUARD_ROWS: GuardRow[] = [
  {
    name: 'the worktree through a symlinked home, home given by its real path',
    home: (f) => f.home,
    path: (f) => join(f.link, 'worktrees', RUN),
    expected: (f) => join(f.real, 'real-home', 'worktrees', RUN),
  },
  {
    name: 'the worktree by its real path, home given through the symlink',
    home: (f) => f.link,
    path: (f) => join(f.home, 'worktrees', RUN),
    expected: (f) => join(f.real, 'real-home', 'worktrees', RUN),
  },
  {
    name: 'a worktree that does not exist',
    home: (f) => f.link,
    path: (f) => join(f.link, 'worktrees', 'gone-run'),
    runId: 'gone-run',
    expected: (f) => join(f.real, 'real-home', 'worktrees', 'gone-run'),
  },
  {
    name: 'a worktree when the worktrees directory does not exist',
    home: (f) => join(f.root, 'empty-home'),
    path: (f) => join(f.root, 'empty-home', 'worktrees', RUN),
    expected: (f) => join(f.real, 'empty-home', 'worktrees', RUN),
  },
  {
    name: 'the -linked directory',
    home: (f) => f.link,
    path: (f) => join(f.home, 'worktrees', `${RUN}-linked`),
    expected: (f) => join(f.real, 'real-home', 'worktrees', `${RUN}-linked`),
  },
  {
    name: 'a child of the -linked directory',
    home: (f) => f.link,
    path: (f) => join(f.home, 'worktrees', `${RUN}-linked`, 'ZLC'),
    expected: (f) => join(f.real, 'real-home', 'worktrees', `${RUN}-linked`, 'ZLC'),
  },
  {
    name: 'another run’s worktree',
    home: (f) => f.home,
    path: (f) => join(f.home, 'worktrees', OTHER),
    expected: () => null,
  },
  {
    name: 'a grandchild of the -linked directory',
    home: (f) => f.home,
    path: (f) => join(f.home, 'worktrees', `${RUN}-linked`, 'ZLC', 'deep'),
    expected: () => null,
  },
  {
    name: 'a path with a .. segment that leads back to the worktree',
    home: (f) => f.home,
    path: (f) => `${join(f.home, 'worktrees', OTHER)}/../${RUN}`,
    expected: () => null,
  },
  {
    name: 'a relative path',
    home: (f) => f.home,
    path: () => `worktrees/${RUN}`,
    expected: () => null,
  },
  {
    name: 'a child of the -linked directory that is a symlink out of the home',
    home: (f) => f.home,
    path: (f) => join(f.home, 'worktrees', `${RUN}-linked`, 'EVIL'),
    expected: () => null,
  },
  {
    name: 'a path through a symlink loop',
    home: (f) => f.home,
    path: (f) => join(f.root, 'loop-a', 'x'),
    expected: () => null,
  },
]

describe('guardPath', () => {
  it.each(GUARD_ROWS)('$name', (row) => {
    const f = fixture()
    const verdict = guardPath(row.home(f), row.runId ?? RUN, row.path(f))
    const expected = row.expected(f)
    if (expected === null) {
      expect(verdict.ok).toBe(false)
    } else {
      expect(verdict).toEqual({ ok: true, resolved: expected })
    }
  })

  it('computes no canonical path for a loop and the real one for a missing tail', () => {
    const f = fixture()
    expect(canonicalPath(join(f.root, 'loop-a'))).toBeNull()
    expect(canonicalPath(join(f.link, 'no', 'such'))).toBe(join(f.real, 'real-home', 'no', 'such'))
  })
})

// ── The log ────────────────────────────────────────────────────────────────────────────────

const readLog = (home: string): LogLine[] =>
  readFileSync(join(home, LOG_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as LogLine)

/** A git whose `worktree remove` really deletes the directory. */
const realisticGit = (): Git =>
  ({
    removeWorktree: async (_repo: string, dir: string) => rmSync(dir, { recursive: true }),
  }) as unknown as Git

interface CallerRow {
  caller: RemovalCaller
  action: 'remove' | 'delete'
  path: (home: string) => string
}

const CALLER_ROWS: CallerRow[] = [
  { caller: 'run_end', action: 'remove', path: (h) => join(h, 'worktrees', RUN) },
  { caller: 'delivery_prepare', action: 'remove', path: (h) => join(h, 'worktrees', RUN) },
  { caller: 'draft_prepare', action: 'remove', path: (h) => join(h, 'worktrees', RUN) },
  {
    caller: 'linked_prepare',
    action: 'remove',
    path: (h) => join(h, 'worktrees', `${RUN}-linked`, 'ZLC'),
  },
  { caller: 'cleanup', action: 'delete', path: (h) => join(h, 'worktrees', `${RUN}-linked`) },
  { caller: 'recreate', action: 'remove', path: (h) => join(h, 'worktrees', RUN) },
  { caller: 'recreate', action: 'delete', path: (h) => join(h, 'worktrees', RUN) },
]

describe('the removal log', () => {
  it.each(CALLER_ROWS)('logs one line for $action by $caller', async (row) => {
    const f = fixture()
    const ctx = { home: f.home, runId: RUN, clock }
    const path = row.path(f.home)
    if (row.action === 'remove')
      await removeCheckout(ctx, realisticGit(), '/repo', row.caller, path)
    else await deleteDirectory(ctx, row.caller, path)

    const [line, ...rest] = readLog(f.home)
    expect(rest).toEqual([])
    expect(line).toEqual({
      time: NOW.toISOString(),
      pid: process.pid,
      action: row.action,
      run_id: RUN,
      caller: row.caller,
      path,
      resolved: join(f.real, 'real-home', path.slice(f.home.length + 1)),
      result: row.action === 'remove' ? 'removed' : 'deleted',
    })
    expect(existsSync(path)).toBe(false)
  })

  it('appends to a log that already holds a line', async () => {
    const f = fixture()
    writeFileSync(join(f.home, LOG_FILE), '{"first":1}\n')
    const ctx = { home: f.home, runId: RUN, clock }
    await removeCheckout(ctx, realisticGit(), '/repo', 'run_end', join(f.home, 'worktrees', RUN))
    await deleteDirectory(ctx, 'run_end', join(f.home, 'worktrees', `${RUN}-linked`))
    const lines = readFileSync(join(f.home, LOG_FILE), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('{"first":1}')
  })

  it('removes the directory although the log cannot be written', async () => {
    const f = fixture()
    mkdirSync(join(f.home, LOG_FILE))
    const line = await removeCheckout(
      { home: f.home, runId: RUN, clock },
      realisticGit(),
      '/repo',
      'run_end',
      join(f.home, 'worktrees', RUN),
    )
    expect(line.result).toBe('removed')
    expect(existsSync(join(f.home, 'worktrees', RUN))).toBe(false)
  })

  it('keeps the last 4,096 characters of git’s output when a removal fails', async () => {
    const f = fixture()
    const output = `${'a'.repeat(5_904)}${'b'.repeat(4_096)}`
    const git = {
      removeWorktree: async () => {
        throw new GitError('git worktree remove', output)
      },
    } as unknown as Git
    const line = await removeCheckout(
      { home: f.home, runId: RUN, clock },
      git,
      '/repo',
      'run_end',
      join(f.home, 'worktrees', RUN),
    )
    expect(line.result).toBe('failed')
    expect(line.output).toBe('b'.repeat(4_096))
    expect(readLog(f.home)[0]?.output).toBe('b'.repeat(4_096))
  })

  it('refuses a path outside the run, calling no git, and says why', async () => {
    const f = fixture()
    let called = false
    const git = {
      removeWorktree: async () => {
        called = true
      },
    } as unknown as Git
    const other = join(f.home, 'worktrees', OTHER)
    const line = await removeCheckout(
      { home: f.home, runId: RUN, clock },
      git,
      '/repo',
      'cleanup',
      other,
    )
    expect(line.result).toBe('refused')
    expect(line.output).toEqual(expect.any(String))
    expect(called).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('logs a missing path as absent and calls no git', async () => {
    const f = fixture()
    let called = false
    const git = {
      removeWorktree: async () => {
        called = true
      },
    } as unknown as Git
    const line = await removeCheckout(
      { home: f.home, runId: 'gone-run', clock },
      git,
      '/repo',
      'run_end',
      join(f.home, 'worktrees', 'gone-run'),
    )
    expect(line.result).toBe('absent')
    expect(called).toBe(false)
    expect(readLog(f.home)[0]?.result).toBe('absent')
  })

  it('tells the notifier of a removal but not of an absent path', async () => {
    const f = fixture()
    const seen: string[] = []
    const ctx = {
      home: f.home,
      runId: RUN,
      clock,
      notify: async (line: LogLine) => {
        seen.push(line.result)
      },
    }
    await removeCheckout(ctx, realisticGit(), '/repo', 'run_end', join(f.home, 'worktrees', RUN))
    await removeCheckout(ctx, realisticGit(), '/repo', 'run_end', join(f.home, 'worktrees', RUN))
    expect(seen).toEqual(['removed'])
  })

  it('records a keep line with the error', () => {
    const f = fixture()
    const line = recordLine(
      { home: f.home, runId: RUN, clock },
      {
        action: 'keep',
        caller: 'run_end',
        path: join(f.home, 'worktrees', RUN),
        result: 'kept',
        output: 'boom',
      },
    )
    expect(line).toMatchObject({ action: 'keep', result: 'kept', output: 'boom' })
    expect(readLog(f.home)).toHaveLength(1)
  })
})

// ── The run-directory guard ────────────────────────────────────────────────────────────────

describe('guardRunDir', () => {
  const rows: {
    name: string
    path: (f: Fixture) => string
    runId?: string
    expected: (f: Fixture) => string | null
  }[] = [
    {
      name: 'its own run directory',
      path: (f) => join(f.home, 'runs', RUN),
      expected: (f) => join(f.real, 'real-home', 'runs', RUN),
    },
    {
      name: 'its own run directory through the symlinked home',
      path: (f) => join(f.link, 'runs', RUN),
      expected: (f) => join(f.real, 'real-home', 'runs', RUN),
    },
    {
      name: 'another run directory',
      path: (f) => join(f.home, 'runs', 'other'),
      expected: () => null,
    },
    {
      name: 'a path inside its own',
      path: (f) => join(f.home, 'runs', RUN, 'events.ndjson'),
      expected: () => null,
    },
    { name: 'runs itself', path: (f) => join(f.home, 'runs'), expected: () => null },
    { name: 'its own worktree', path: (f) => join(f.home, 'worktrees', RUN), expected: () => null },
    { name: 'a relative path', path: () => `runs/${RUN}`, expected: () => null },
    {
      name: 'a path with a .. segment',
      path: (f) => `${f.home}/runs/other/../${RUN}`,
      expected: () => null,
    },
    {
      name: 'a run id with a slash',
      path: (f) => join(f.home, 'runs', RUN),
      runId: `a/${RUN}`,
      expected: () => null,
    },
  ]
  it.each(rows)('$name (AC45)', (row) => {
    const f = fixture()
    const verdict = guardRunDir(f.link, row.runId ?? RUN, row.path(f))
    const expected = row.expected(f)
    if (expected === null) expect(verdict.ok).toBe(false)
    else expect(verdict).toEqual({ ok: true, resolved: expected })
  })
})
