import { describe, expect, it } from 'vitest'
import { sweepDecisions, type SweepInput } from '../../src/modules/runs/sweep-rules.js'

const now = new Date('2026-10-20T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)
const S = 1_000
const MIN = 60 * S
const H = 60 * MIN
const running = (silentMs: number) => ({
  id: 'run',
  status: 'running' as const,
  lastHeartbeatAt: ago(silentMs),
})
const open = (ageMs: number) => ({ id: 'approval', status: 'open' as const, createdAt: ago(ageMs) })

describe('sweepDecisions', () => {
  it.each<[string, Partial<SweepInput>, ReturnType<typeof sweepDecisions>]>([
    ['the first tick only arms', { lastTick: null, runs: [running(5 * MIN)] }, { rearm: true }],
    [
      'a run silent 89 s is not lost',
      { runs: [running(89 * S)] },
      { rearm: false, lost: [], expired: [] },
    ],
    [
      'a run silent exactly 90 s is not lost yet',
      { runs: [running(90 * S)] },
      { rearm: false, lost: [], expired: [] },
    ],
    [
      'a run silent 91 s is lost',
      { runs: [running(91 * S)] },
      { rearm: false, lost: ['run'], expired: [] },
    ],
    [
      'a paused run holds no runner, however long it waits',
      { runs: [{ id: 'run', status: 'paused', lastHeartbeatAt: ago(5 * H) }] },
      { rearm: false, lost: [], expired: [] },
    ],
    [
      'after a sleep, the runner gets a full window first',
      { lastTick: ago(10 * MIN), runs: [running(10 * MIN)] },
      { rearm: true },
    ],
    [
      'a gap just under two intervals is no sleep',
      { lastTick: ago(119 * S), runs: [running(3 * MIN)] },
      { rearm: false, lost: ['run'], expired: [] },
    ],
    [
      'an approval at 47 h 59 m stays open',
      { approvals: [open(47 * H + 59 * MIN)] },
      { rearm: false, lost: [], expired: [] },
    ],
    [
      'an approval at 48 h expires',
      { approvals: [open(48 * H)] },
      { rearm: false, lost: [], expired: ['approval'] },
    ],
    [
      'an answered approval never expires',
      { approvals: [{ id: 'approval', status: 'answered', createdAt: ago(50 * H) }] },
      { rearm: false, lost: [], expired: [] },
    ],
    [
      'after a sleep, expiry waits a tick too',
      { lastTick: ago(10 * MIN), approvals: [open(49 * H)] },
      { rearm: true },
    ],
  ])('%s', (_name, input, expected) => {
    expect(
      sweepDecisions({
        now,
        lastTick: ago(60 * S),
        intervalMs: 60 * S,
        runs: [],
        approvals: [],
        ...input,
      }),
    ).toEqual(expected)
  })
})
