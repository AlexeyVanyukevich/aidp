import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BoardApi } from '../../src/api.js'
import type { RunnerEvent } from '../../src/contract.js'
import { runPhase } from '../../src/phases/phase.js'
import { prepareRunDir } from '../../src/phases/run-dir.js'
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
  let token = ''
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
      setToken: (t) => {
        token = t
      },
    },
  )
  return { result, events, runDir }
}

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
