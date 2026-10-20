import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BoardApi } from '../../src/api.js'
import { runProcess, type ProcessInput } from '../../src/phases/process.js'
import { prepareRunDir } from '../../src/phases/run-dir.js'
import { EventSink } from '../../src/sink.js'

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
