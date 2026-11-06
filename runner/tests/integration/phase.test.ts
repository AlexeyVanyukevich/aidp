import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BoardApi } from '../../src/api.js'
import { runnerCode } from '../../src/fingerprint.js'
import type { RunnerEvent } from '../../src/contract.js'
import {
  continuePhase,
  restartPhase,
  runPhase,
  startPhase,
  type PhaseDeps,
  type PhaseRecord,
} from '../../src/phases/phase.js'
import { StartFailure } from '../../src/phases/process.js'
import { CODE_MOVED_MARKER, prepareRunDir } from '../../src/phases/run-dir.js'
import { EventSink } from '../../src/sink.js'

const FIXTURE = join(import.meta.dirname, '../fixtures/stream/plain.ndjson')
const REPLAY = join(import.meta.dirname, '../fake/stream-replay.ts')
const TSX = join(import.meta.dirname, '../../../node_modules/.bin/tsx')

/** A shell script standing in for `claude`, passing its flags to the replay after its own. */
function fakeClaude(extra: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'claude-')), 'claude')
  writeFileSync(path, `#!/bin/sh\nexec "${TSX}" "${REPLAY}" "${FIXTURE}" ${extra} "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

function recordingApi() {
  const events: RunnerEvent[] = []
  const tokens: string[] = []
  const api = {
    issueToken: async () => {
      tokens.push(`t${tokens.length}`)
      return tokens.at(-1)!
    },
    retire: async () => undefined,
    sendEvents: async (_t: string, batch: RunnerEvent[]) => {
      events.push(...batch)
      return batch.length
    },
  } as unknown as BoardApi
  return { api, events }
}

async function phase(extra = '') {
  const runDir = mkdtempSync(join(tmpdir(), 'rundir-'))
  prepareRunDir(runDir)
  const { api, events } = recordingApi()
  const token = 'carry-token'
  const result = await runPhase(
    {
      runId: '00000000-0000-4000-8000-000000000001',
      phase: 'plan',
      attempt: 1,
      handoff: '<task/>',
      worktree: tmpdir(),
      runDir,
      budgetUsd: null,
    },
    {
      api,
      sink: new EventSink(api, join(runDir, 'events.ndjson'), () => token),
      claudeBin: fakeClaude(extra),
      boardUrl: 'http://127.0.0.1:1',
      runnerCode: runnerCode(),
    },
  )
  return { result, events, runDir }
}

describe('prepareRunDir', () => {
  it('turns off Claude Code’s commit and pull request attribution', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'rundir-'))
    prepareRunDir(runDir)
    const settings = JSON.parse(readFileSync(join(runDir, 'settings.json'), 'utf8'))
    expect(settings.attribution).toEqual({ commit: '', pr: '' })
  })
})

describe('runPhase', () => {
  it('reports the phase’s start, its usage and its end with Claude Code’s own cost', async () => {
    const { result, events } = await phase()
    expect(result.ok).toBe(true)
    expect(events[0]).toMatchObject({
      type: 'phase_start',
      agent: 'planner',
      model: 'sonnet',
      payload: { name: 'plan', attempt: 1 },
    })
    expect(events.filter((e) => e.type === 'message').length).toBeGreaterThan(0)
    const end = events.at(-1)!
    expect(end).toMatchObject({
      type: 'phase_end',
      payload: { status: 'succeeded', session_id: result.sessionId },
    })
    expect(
      Object.values(end.payload.reported_cost as Record<string, number>).every((usd) => usd > 0),
    ).toBe(true)
  })

  // Review Focus 2.
  it('keeps going past a line that is not JSON, and keeps the line', async () => {
    const { result, runDir } = await phase('--noise')
    expect(result.ok).toBe(true)
    expect(readFileSync(join(runDir, 'plan-1.stdout-noise.log'), 'utf8')).toContain(
      'Warning: something the CLI says',
    )
  })

  it('fails the phase on a non-zero exit, with the end of stderr', async () => {
    const { result, events } = await phase('--exit 3')
    expect(result.ok).toBe(false)
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      payload: { exit_code: 3, stderr_tail: expect.stringContaining('a line on stderr') },
    })
    expect(events.at(-1)).toMatchObject({ type: 'phase_end', payload: { status: 'failed' } })
  })
})

// AC3: the sink's token is carry's alone. Bringing `setToken` back makes this directive unused.
// @ts-expect-error `setToken` is not part of `PhaseDeps`
type NoSetToken = PhaseDeps['setToken']

describe('the sink’s token', () => {
  const RUN = '00000000-0000-4000-8000-000000000001'
  const record: PhaseRecord = {
    runId: RUN,
    phaseId: '00000000-0000-4000-8000-0000000000aa',
    phase: 'plan',
    attempt: 1,
    sessionId: '00000000-0000-4000-8000-0000000000bb',
    baseline: {},
    reported: {},
    interrupted: false,
    summary: '',
  }
  const starts: {
    name: string
    run: (
      deps: PhaseDeps,
      input: { worktree: string; runDir: string; budgetUsd: null },
    ) => Promise<unknown>
  }[] = [
    {
      name: 'startPhase',
      run: (deps, io) =>
        startPhase({ runId: RUN, phase: 'plan', attempt: 1, handoff: '<task/>', ...io }, deps),
    },
    { name: 'continuePhase', run: (deps, io) => continuePhase(record, 'go on', io, deps) },
    { name: 'restartPhase', run: (deps, io) => restartPhase(record, '<task/>', io, deps) },
  ]

  it.each(starts)('$name sends every event with the sink’s token', async ({ run }) => {
    const runDir = mkdtempSync(join(tmpdir(), 'rundir-'))
    prepareRunDir(runDir)
    const sent: string[] = []
    const issued: string[] = []
    const retired: string[] = []
    const api = {
      issueToken: async () => {
        issued.push(`step-${issued.length}`)
        return issued.at(-1)!
      },
      retire: async (t: string) => {
        retired.push(t)
      },
      sendEvents: async (t: string, batch: RunnerEvent[]) => {
        sent.push(t)
        return batch.length
      },
    } as unknown as BoardApi
    const envFile = join(runDir, 'env-token')
    const claude = join(mkdtempSync(join(tmpdir(), 'claude-')), 'claude')
    writeFileSync(
      claude,
      `#!/bin/sh\nprintf '%s' "$BOARD_RUN_TOKEN" > "${envFile}"\nexec "${TSX}" "${REPLAY}" "${FIXTURE}" "$@"\n`,
    )
    chmodSync(claude, 0o755)

    await run(
      {
        api,
        sink: new EventSink(api, join(runDir, 'events.ndjson'), () => 'T'),
        claudeBin: claude,
        boardUrl: 'http://127.0.0.1:1',
        runnerCode: runnerCode(),
      },
      { worktree: tmpdir(), runDir, budgetUsd: null },
    )

    expect(sent.length).toBeGreaterThan(0)
    expect(new Set(sent)).toEqual(new Set(['T']))
    const processToken = readFileSync(envFile, 'utf8')
    expect(processToken).not.toBe('T')
    expect(issued).toEqual([processToken])
    expect(retired).toEqual([processToken])
  })
})

describe('startPhase with a binary that does not exist', () => {
  it('AC10: rejects with the start failure and retires the token it issued', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'rundir-'))
    prepareRunDir(runDir)
    const retired: string[] = []
    const api = {
      issueToken: async () => 'issued-token',
      retire: async (token: string) => void retired.push(token),
      sendEvents: async (_t: string, batch: RunnerEvent[]) => batch.length,
    } as unknown as BoardApi
    const missing = join(tmpdir(), `absent-${crypto.randomUUID()}`, 'claude')
    await expect(
      startPhase(
        {
          runId: '00000000-0000-4000-8000-000000000001',
          phase: 'plan',
          attempt: 1,
          handoff: '<task/>',
          worktree: tmpdir(),
          runDir,
          budgetUsd: null,
        },
        {
          api,
          sink: new EventSink(api, join(runDir, 'events.ndjson'), () => 't'),
          claudeBin: missing,
          boardUrl: 'http://127.0.0.1:1',
          runnerCode: runnerCode(),
        },
      ),
    ).rejects.toBeInstanceOf(StartFailure)
    expect(retired).toEqual(['issued-token'])
  })
})

// R5, R6: the real step() against the fake claude, with the fingerprint moving.
describe('a phase when the runner code moves', () => {
  function setUp() {
    const runDir = mkdtempSync(join(tmpdir(), 'rundir-'))
    prepareRunDir(runDir)
    const { api, events } = recordingApi()
    const spawned = join(runDir, 'spawned')
    const claude = join(mkdtempSync(join(tmpdir(), 'claude-')), 'claude')
    writeFileSync(
      claude,
      `#!/bin/sh\ntouch "${spawned}"\nexec "${TSX}" "${REPLAY}" "${FIXTURE}" "$@"\n`,
    )
    chmodSync(claude, 0o755)
    const input = {
      runId: '00000000-0000-4000-8000-000000000001',
      phase: 'plan' as const,
      attempt: 1,
      handoff: '<task/>',
      worktree: tmpdir(),
      runDir,
      budgetUsd: null,
    }
    const deps = (reads: string[]): PhaseDeps => ({
      api,
      sink: new EventSink(api, join(runDir, 'events.ndjson'), () => 't'),
      claudeBin: claude,
      boardUrl: 'http://127.0.0.1:1',
      runnerCode: 'start',
      currentCode: () => reads.shift() ?? reads.at(-1) ?? 'start',
    })
    return { runDir, input, deps, spawned }
  }

  it('starts no process when the code moved before it, and writes the marker', async () => {
    const { runDir, input, deps, spawned } = setUp()
    const failure = await startPhase(input, deps(['moved'])).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(StartFailure)
    expect(failure).toMatchObject({ command: 'runner code check' })
    expect(existsSync(spawned)).toBe(false)
    expect(existsSync(join(runDir, CODE_MOVED_MARKER))).toBe(true)
  })

  it('sets codeMoved and writes the marker when the code moved while the process ran', async () => {
    const { runDir, input, deps } = setUp()
    const result = await startPhase(input, deps(['start', 'moved']))
    expect(result.codeMoved).toBe(true)
    expect(existsSync(join(runDir, CODE_MOVED_MARKER))).toBe(true)
  })

  it('leaves codeMoved unset when the code did not move', async () => {
    const { runDir, input, deps } = setUp()
    const result = await startPhase(input, deps(['start']))
    expect(result.codeMoved).toBeUndefined()
    expect(existsSync(join(runDir, CODE_MOVED_MARKER))).toBe(false)
  })
})
