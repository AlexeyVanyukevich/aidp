import type { ChildProcess, spawn as spawnType } from 'node:child_process'
import { EventEmitter, getEventListeners } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardApi } from '../../src/api.js'
import { PHASES } from '../../src/phases/agents.js'
import { runProcess, StartFailure, type ProcessInput } from '../../src/phases/process.js'
import { CODE_MOVED_MARKER, prepareRunDir } from '../../src/phases/run-dir.js'
import { EventSink } from '../../src/sink.js'

// A pass-through: the real spawn, unless a test sets an override (reset after each test).
const mocked = vi.hoisted(() => ({ override: null as null | ((...args: unknown[]) => unknown) }))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    spawn: (...args: unknown[]) =>
      mocked.override === null
        ? (actual.spawn as (...a: unknown[]) => unknown)(...args)
        : mocked.override(...args),
  }
})
const { spawn } = await vi.importActual<{ spawn: typeof spawnType }>('node:child_process')
afterEach(() => {
  mocked.override = null
})

/** A shell script standing in for `claude`; `body` runs with the run directory in its env. */
function standIn(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'claude-')), 'claude')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const TIMING = { pauseGraceMs: 200, stopGraceMs: 300, markerPollMs: 20 }

function setUp(body: string) {
  const runDir = mkdtempSync(join(tmpdir(), 'rundir-'))
  prepareRunDir(runDir)
  const api = { sendEvents: async () => 0 } as unknown as BoardApi
  const input: ProcessInput = {
    runId: '00000000-0000-4000-8000-000000000001',
    phaseId: '00000000-0000-4000-8000-000000000002',
    phase: 'build',
    attempt: 1,
    prompt: '<task/>',
    sessionId: '00000000-0000-4000-8000-000000000003',
    resume: false,
    worktree: tmpdir(),
    runDir,
    budgetUsd: null,
    baseline: {},
    token: 't',
  }
  const deps = {
    sink: new EventSink(api, join(runDir, 'events.ndjson'), () => 't'),
    claudeBin: standIn(body),
    boardUrl: 'http://127.0.0.1:1',
    runnerCode: 'start-code',
    ...TIMING,
  }
  return { runDir, input, deps, pidFile: join(runDir, 'build-1.pid') }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runProcess', () => {
  it('AC1: puts the worktree in the env as BOARD_WORKTREE', async () => {
    const { runDir, input, deps } = setUp(
      'printf %s "$BOARD_WORKTREE" > "$BOARD_RUN_DIR/worktree.txt"',
    )
    await runProcess(input, deps)
    expect(readFileSync(join(runDir, 'worktree.txt'), 'utf8')).toBe(input.worktree)
  })

  it('passes the run variables and none of the runner’s own', async () => {
    const saved = { ...process.env }
    Object.assign(process.env, {
      RUNNER_KEY: 'k',
      DATABASE_URL: 'd',
      PORT: '1',
      BOARD_HOME: '/the/real/home',
    })
    try {
      const { runDir, input, deps } = setUp('env > "$BOARD_RUN_DIR/env.txt"')
      await runProcess(input, deps)
      const lines = readFileSync(join(runDir, 'env.txt'), 'utf8').split('\n')
      for (const name of ['RUNNER_KEY=', 'DATABASE_URL=', 'PORT=', 'BOARD_HOME=']) {
        expect(lines.some((line) => line.startsWith(name))).toBe(false)
      }
      const expected = {
        BOARD_URL: deps.boardUrl,
        BOARD_RUN_TOKEN: input.token,
        BOARD_RUN_ID: input.runId,
        BOARD_PHASE_ID: input.phaseId,
        BOARD_PHASE: input.phase,
        BOARD_AGENT: PHASES[input.phase].agent,
        BOARD_RUN_DIR: runDir,
        BOARD_WORKTREE: input.worktree,
        BOARD_RUNNER_CODE: 'start-code',
      }
      for (const [key, value] of Object.entries(expected)) {
        expect(lines).toContain(`${key}=${value}`)
      }
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  })

  // R10: what the session is told on a resume after the runner restarted on its new code.
  describe('the code-moved marker', () => {
    const LINE = 'The runner restarted on its new code since your last turn; tool calls work again.'
    const rows: {
      name: string
      resume: boolean
      marker: boolean
      prompt: string
      expected: string
    }[] = [
      {
        name: 'a resume with the marker',
        resume: true,
        marker: true,
        prompt: 'INTERRUPTED',
        expected: `${LINE}\n\nINTERRUPTED`,
      },
      {
        name: 'a resume with the marker and a note',
        resume: true,
        marker: true,
        prompt: 'NOTE\n\nINTERRUPTED',
        expected: `${LINE}\n\nNOTE\n\nINTERRUPTED`,
      },
      {
        name: 'a resume without the marker',
        resume: true,
        marker: false,
        prompt: 'INTERRUPTED',
        expected: 'INTERRUPTED',
      },
      {
        name: 'a new session with the marker',
        resume: false,
        marker: true,
        prompt: '<task/>',
        expected: '<task/>',
      },
    ]
    it.each(rows)('$name', async ({ resume, marker, prompt, expected }) => {
      const { runDir, input, deps } = setUp('printf %s "$2" > "$BOARD_RUN_DIR/prompt.txt"')
      if (marker) writeFileSync(join(runDir, CODE_MOVED_MARKER), '')
      await runProcess({ ...input, resume, prompt }, deps)
      expect(readFileSync(join(runDir, 'prompt.txt'), 'utf8')).toBe(expected)
      expect(existsSync(join(runDir, CODE_MOVED_MARKER))).toBe(false)
    })
  })

  it('keeps a pid file while the process runs, and removes it after', async () => {
    const { input, deps, pidFile } = setUp('sleep 0.4')
    const running = runProcess(input, deps)
    await new Promise((done) => setTimeout(done, 150))
    expect(existsSync(pidFile)).toBe(true)
    const result = await running
    expect(result).toMatchObject({ exitCode: 0, stopped: 'no', interrupted: false })
    expect(existsSync(pidFile)).toBe(false)
  })

  it('ends a process that keeps going after the pause, once its grace is over', async () => {
    const { input, deps } = setUp('touch "$BOARD_RUN_DIR/paused"\nexec sleep 30')
    const started = Date.now()
    const result = await runProcess(input, deps)
    expect(result).toMatchObject({ stopped: 'paused', interrupted: true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(TIMING.pauseGraceMs)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('lets a process that pauses and ends its turn end by itself', async () => {
    const { input, deps } = setUp('touch "$BOARD_RUN_DIR/paused"\nexit 0')
    expect(await runProcess(input, deps)).toMatchObject({ stopped: 'paused', interrupted: false })
  })

  it('pauses on the heartbeat’s word when no marker comes', async () => {
    const { input, deps } = setUp('exec sleep 30')
    let asked = false
    setTimeout(() => (asked = true), 100)
    const result = await runProcess(input, { ...deps, pauseRequested: () => asked })
    expect(result).toMatchObject({ stopped: 'paused', interrupted: true })
  })

  // Node, not a shell trap: it signals readiness once its handler is in place, so the test
  // never sends SIGTERM to a process that cannot yet ignore it.
  const IGNORES_TERM = `exec node -e "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.env.BOARD_RUN_DIR + '/ready', ''); setTimeout(() => {}, 30000)"`

  it.each([
    ['a cancel', 'cancelled', 'signal'],
    ['the daemon stopping', 'shutdown', 'shutdown'],
  ] as const)('stops for %s with SIGTERM, then SIGKILL if ignored', async (_name, stopped, key) => {
    const { input, deps, runDir } = setUp(IGNORES_TERM)
    const controller = new AbortController()
    const running = runProcess(input, { ...deps, [key]: controller.signal })
    while (!existsSync(join(runDir, 'ready'))) await new Promise((done) => setTimeout(done, 20))
    const signalled = Date.now()
    controller.abort()
    const result = await running
    expect(result).toMatchObject({ stopped, interrupted: true })
    // It ignored SIGTERM, so it ended only at SIGKILL, after the stop grace.
    expect(Date.now() - signalled).toBeGreaterThanOrEqual(TIMING.stopGraceMs)
  })

  it('removes a marker left from before, so a resumed process is not paused at once', async () => {
    const { input, deps, runDir } = setUp('exit 0')
    writeFileSync(join(runDir, 'paused'), '')
    expect(await runProcess({ ...input, resume: true }, deps)).toMatchObject({ stopped: 'no' })
  })

  it('ends a process its pid file names, when it is a claude process, before starting', async () => {
    const { input, deps, pidFile } = setUp('exit 0')
    const leftover = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'claude'], {
      stdio: 'ignore',
    })
    writeFileSync(pidFile, String(leftover.pid))
    await runProcess(input, deps)
    await new Promise((done) => setTimeout(done, 100))
    expect(alive(leftover.pid!)).toBe(false)
  })

  it('leaves alone a process its pid file names that is not claude', async () => {
    const { input, deps, pidFile } = setUp('exit 0')
    const unrelated = spawn('sleep', ['30'], { stdio: 'ignore' })
    writeFileSync(pidFile, String(unrelated.pid))
    await runProcess(input, deps)
    expect(alive(unrelated.pid!)).toBe(true)
    unrelated.kill('SIGKILL')
  })
})

/** A child that never started: no pid, an 'error' then a 'close' with the negative errno. */
function failingChild(code: string, errno: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { pid: undefined, stdout: new PassThrough(), stderr: new PassThrough() })
  child.kill = () => true
  setImmediate(() => {
    child.emit('error', Object.assign(new Error(`spawn x ${code}`), { code }))
    child.emit('close', errno)
  })
  return child
}

interface StartRow {
  name: string
  claudeBin: () => string
  worktree: (fallback: string) => string
  prompt?: string
  spawnOverride?: () => ChildProcess
  code: string
  has: string[]
  hasNot: string[]
  endsWith: string
}

const missingDir = () => join(tmpdir(), `absent-${crypto.randomUUID()}`)
const notExecutable = () => {
  const path = standIn('exit 0')
  chmodSync(path, 0o644)
  return path
}

const START_ROWS: StartRow[] = [
  {
    name: 'absolute path missing',
    claudeBin: () => join(missingDir(), 'claude'),
    worktree: (w) => w,
    code: 'ENOENT',
    has: ['ENOENT', 'CLAUDE_BIN'],
    hasNot: ['PATH'],
    endsWith: 'then Resume',
  },
  {
    name: 'bare name not on PATH',
    claudeBin: () => `claude-absent-${crypto.randomUUID()}`,
    worktree: (w) => w,
    code: 'ENOENT',
    has: ['ENOENT', 'CLAUDE_BIN', 'PATH'],
    hasNot: [],
    endsWith: 'then Resume',
  },
  {
    name: 'worktree missing',
    claudeBin: () => standIn('exit 0'),
    worktree: () => missingDir(),
    code: 'ENOENT',
    has: ['ENOENT', 'worktree is missing'],
    hasNot: ['CLAUDE_BIN', 'PATH'],
    endsWith: 'then Resume',
  },
  {
    name: 'not executable',
    claudeBin: notExecutable,
    worktree: (w) => w,
    code: 'EACCES',
    has: ['EACCES', 'CLAUDE_BIN'],
    hasNot: ['PATH'],
    endsWith: 'then Resume',
  },
  {
    name: 'EMFILE',
    claudeBin: () => '/bin/claude',
    worktree: (w) => w,
    spawnOverride: () => failingChild('EMFILE', -24),
    code: 'EMFILE',
    has: ['EMFILE', 'Resume starts the process again'],
    hasNot: ['CLAUDE_BIN', 'PATH', 'worktree'],
    endsWith: 'Resume starts the process again',
  },
  {
    name: 'NUL byte',
    claudeBin: () => standIn('exit 0'),
    worktree: (w) => w,
    prompt: 'a\0b',
    code: 'ERR_INVALID_ARG_VALUE',
    has: ['ERR_INVALID_ARG_VALUE', 'Resume will retry the same arguments'],
    hasNot: ['CLAUDE_BIN', 'PATH', 'worktree'],
    endsWith: 'Resume will retry the same arguments',
  },
]

describe('runProcess start failures', () => {
  it.each(START_ROWS)('AC1-6: $name', async (row) => {
    const { input, deps } = setUp('exit 0')
    const claudeBin = row.claudeBin()
    if (row.spawnOverride) mocked.override = row.spawnOverride
    const uncaught: unknown[] = []
    const record = (error: unknown) => uncaught.push(error)
    process.on('uncaughtException', record)
    try {
      const error = await runProcess(
        { ...input, worktree: row.worktree(input.worktree), prompt: row.prompt ?? input.prompt },
        { ...deps, claudeBin },
      ).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(StartFailure)
      const failure = error as StartFailure
      expect(failure.command).toBe(claudeBin)
      expect(failure.output).toContain(row.code)
      for (const text of row.has) expect(failure.output).toContain(text)
      for (const text of row.hasNot) expect(failure.output).not.toContain(text)
      expect(failure.output.endsWith(row.endsWith)).toBe(true)
      await new Promise((done) => setTimeout(done, 20))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', record)
    }
  })

  it.each(START_ROWS.filter((row) => row.code === 'ENOENT' || row.code === 'EACCES').slice(0, 4))(
    'AC7: sends nothing after rejecting, $name',
    async (row) => {
      const { input, deps } = setUp('exit 0')
      const sent: unknown[] = []
      const sink = { send: async (events: unknown[]) => void sent.push(...events) }
      await expect(
        runProcess(
          { ...input, worktree: row.worktree(input.worktree) },
          { ...deps, sink: sink as unknown as typeof deps.sink, claudeBin: row.claudeBin() },
        ),
      ).rejects.toBeInstanceOf(StartFailure)
      const before = sent.length
      await new Promise((done) => setTimeout(done, 200))
      expect(sent.length).toBe(before)
    },
  )

  it('AC8: leaves no listener, timer or pid file behind', async () => {
    const { input, deps, runDir, pidFile } = setUp('exit 0')
    const signal = new AbortController().signal
    const shutdown = new AbortController().signal
    const timeouts = () =>
      process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
    const before = timeouts()
    await expect(
      runProcess(input, { ...deps, claudeBin: join(missingDir(), 'claude'), signal, shutdown }),
    ).rejects.toBeInstanceOf(StartFailure)
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(shutdown, 'abort')).toHaveLength(0)
    expect(timeouts()).toBeLessThanOrEqual(before)
    expect(existsSync(pidFile)).toBe(false)
    expect(existsSync(join(runDir, 'build-1.pid'))).toBe(false)
  })

  it('AC9: logs an error after the start and still returns the exit code', async () => {
    const { input, deps, runDir } = setUp('sleep 0.2')
    mocked.override = (...args) => {
      const child = (spawn as (...a: unknown[]) => ChildProcess)(...args)
      setTimeout(() => child.emit('error', new Error('late kill failure')), 50)
      return child
    }
    const result = await runProcess(input, deps)
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(runDir, 'build-1.stderr.log'), 'utf8')).toContain('late kill failure')
  })
})
