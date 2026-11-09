import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardApi } from '../../src/api.js'
import type { RunnerConfig } from '../../src/config.js'
import type { Work } from '../../src/contract.js'
import { Daemon } from '../../src/daemon.js'
import { NOW, RUN, START, checkpoint, harness, resume, withPlan } from './run-harness.js'

const START_CODE = 'start-code'
const MOVED = 'moved-code'
/** A read that throws, as one does when a pull removes a file between the listing and the read. */
const UNREADABLE = 'unreadable'

const cleanup: Work = {
  kind: 'cleanup',
  run: { id: RUN.id, repo_path: '/repo', worktree_path: null },
}
const RESUME = resume(checkpoint('build', 1, 'p'), 'INTERRUPTED')

afterEach(() => vi.restoreAllMocks())

/** A daemon over the delivery harness, a scripted board and a scripted fingerprint. */
function setUp(options: {
  fingerprints: string[]
  claims?: (Work | null)[]
  /** What the title lane's claims return, in turn. */
  titleClaims?: (Work | null)[]
  cancel?: string[]
  now?: Date
  clock?: () => Date
  config?: Partial<RunnerConfig>
  /** How long a title claim stays open before it returns. */
  titleClaimMs?: number
  /** Every heartbeat is sent, and fails, as one does while the board is down. */
  heartbeatFails?: boolean
}) {
  const h = withPlan(harness({}))
  const clock = options.clock ?? (() => options.now ?? NOW)
  const log: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => void log.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation((line: string) => void log.push(String(line)))
  const events: string[] = []
  const claims = [...(options.claims ?? [])]
  const titleClaims = [...(options.titleClaims ?? [])]
  /** The kinds each claim request asked for, in order. */
  const asked: (readonly string[] | undefined)[] = []
  /** Each heartbeat: when it was sent, by the daemon's clock, and for which runs. */
  const beats: { at: string; runIds: string[] }[] = []
  const reads = options.fingerprints
  let read = 0
  const api = {
    ...h.deps.api,
    claim: async (_runnerId: string, _waitMs: number, kinds?: readonly string[]) => {
      asked.push(kinds)
      const title = kinds?.some((kind) => kind === 'title' || kind === 'rephrase') === true
      events.push(title ? 'claim:title' : 'claim')
      await new Promise((done) => setTimeout(done, title ? (options.titleClaimMs ?? 2) : 2))
      return (title ? titleClaims : claims).shift() ?? null
    },
    heartbeat: async (_runnerId: string, runIds: string[]) => {
      beats.push({ at: clock().toISOString(), runIds })
      if (options.heartbeatFails === true) throw new Error('fetch failed')
      events.push(`heartbeat (stages so far: ${h.calls.length})`)
      return { cancel: options.cancel ?? [], pause: [] }
    },
  } as unknown as BoardApi
  const exits: number[] = []
  const settles: number[] = []
  const handoffPath = join(h.home, 'handoff.json')
  const daemon = new Daemon(
    { ...h.deps.config, ...options.config },
    {
      api,
      git: h.deps.git,
      phases: h.deps.phases,
      runTests: h.deps.runTests!,
      clock,
      fingerprint: () => {
        read += 1
        const value = reads[Math.min(read - 1, reads.length - 1)] ?? START_CODE
        if (value === UNREADABLE) throw new Error('ENOENT: no such file or directory')
        return value
      },
      exit: (status) => void exits.push(status),
      settle: async () => void settles.push(read),
      handoffPath,
    },
  )
  return { h, daemon, log, events, beats, exits, settles, handoffPath, asked, reads: () => read }
}

const never = new AbortController().signal

describe('the moved-code check before a claim', () => {
  // The daemon reads once for its start fingerprint, then the check reads.
  const rows: {
    name: string
    reads: string[]
    readsAfterStart: number
    settled: boolean
    claimed: boolean
    exit: number | null
  }[] = [
    {
      name: 'the start fingerprint',
      reads: [START_CODE, START_CODE],
      readsAfterStart: 1,
      settled: false,
      claimed: true,
      exit: null,
    },
    {
      name: 'the same new value twice',
      reads: [START_CODE, MOVED, MOVED],
      readsAfterStart: 2,
      settled: true,
      claimed: false,
      exit: 75,
    },
    {
      name: 'a new value, then another',
      reads: [START_CODE, MOVED, 'again', START_CODE],
      readsAfterStart: 2,
      settled: true,
      claimed: true,
      exit: null,
    },
    {
      name: 'a read that fails, then the start fingerprint',
      reads: [START_CODE, UNREADABLE, START_CODE],
      readsAfterStart: 2,
      settled: true,
      claimed: true,
      exit: null,
    },
    {
      name: 'two reads that fail',
      reads: [START_CODE, UNREADABLE, UNREADABLE, START_CODE],
      readsAfterStart: 2,
      settled: true,
      claimed: true,
      exit: null,
    },
  ]
  it.each(rows)('reads $name', async (row) => {
    const t = setUp({ fingerprints: row.reads })
    const stop = new AbortController()
    // One pass of the loop: the claim returns nothing, then the loop is stopped.
    const run = t.daemon.loop(stop.signal)
    await new Promise((done) => setTimeout(done, 20))
    stop.abort()
    await run
    expect(t.events.includes('claim')).toBe(row.claimed)
    expect(t.settles.length).toBe(row.settled ? 1 : 0)
    expect(t.exits).toEqual(row.exit === null ? [] : [row.exit])
    if (row.exit !== null)
      expect(t.log.some((l) => l.startsWith('board-cli: ') && l.includes('restarting'))).toBe(true)
    expect(t.reads() - 1).toBeGreaterThanOrEqual(row.readsAfterStart)
  })

  it('never exits for a daemon whose code has not moved', async () => {
    const t = setUp({ fingerprints: [START_CODE] })
    const stop = new AbortController()
    const run = t.daemon.loop(stop.signal)
    await new Promise((done) => setTimeout(done, 20))
    stop.abort()
    await run
    expect(t.exits).toEqual([])
  })
})

describe('a claim that returns work after the code moved', () => {
  // Start fingerprint, then the check after the claim reads the moved value twice.
  const moved = [START_CODE, MOVED, MOVED, MOVED]

  it.each<[string, Work]>([
    ['a start', START],
    ['a resume', RESUME],
  ])('hands %s on and exits 75 without carrying it out', async (_name, work) => {
    const t = setUp({ fingerprints: moved, claims: [work] })
    await t.daemon.runOnce(never)
    expect(JSON.parse(readFileSync(t.handoffPath, 'utf8'))).toEqual({
      work: JSON.parse(JSON.stringify(work)),
      claimed_at: NOW.toISOString(),
    })
    expect(t.h.calls).toEqual([])
    expect(t.exits).toEqual([75])
    expect(t.log.some((l) => l.startsWith('board-cli: ') && l.includes('handed'))).toBe(true)
  })

  // The daemon waits 100 ms (claim wait + grace) for the title lane, whose claim stays open 250 ms.
  const WAIT_MS = 100
  it.each([
    { name: 'that get through', fail: false, stamp: 'the last heartbeat' },
    { name: 'that fail', fail: true, stamp: 'the claim' },
  ])(
    'heartbeats a claim while the title lane is waited for; with heartbeats $name, stamps $stamp',
    async ({ fail }) => {
      const started = Date.now()
      // The start read; the loops' shared check before their claims; the check after the claim.
      const t = setUp({
        fingerprints: [START_CODE, START_CODE, MOVED, MOVED],
        claims: [START],
        titleClaimMs: 250,
        heartbeatFails: fail,
        config: { claimWaitMs: WAIT_MS, stopGraceMs: 0, heartbeatMs: 20 },
        clock: () => new Date(NOW.getTime() + (Date.now() - started)),
      })
      await t.daemon.loop(new AbortController().signal)
      const held = t.beats.filter((b) => b.runIds.includes(RUN.id))
      expect(held.length).toBeGreaterThanOrEqual(2)
      const handed = JSON.parse(readFileSync(t.handoffPath, 'utf8')) as { claimed_at: string }
      const stamped = Date.parse(handed.claimed_at)
      if (fail) {
        // The claim's own moment: before the wait, never its end.
        expect(stamped).toBeLessThan(NOW.getTime() + WAIT_MS)
      } else {
        // The daemon reads its clock just before the heartbeat the board records.
        const last = Date.parse(held.at(-1)?.at ?? '')
        expect(stamped).toBeLessThanOrEqual(last)
        expect(stamped).toBeGreaterThan(last - 10)
      }
      expect(t.exits).toEqual([75])
    },
  )

  it('carries a cleanup out itself, writes no handoff and exits 75 before another claim', async () => {
    // The start read and the check before the claim see the start value; the rest see the move.
    const t = setUp({ fingerprints: [START_CODE, START_CODE, MOVED], claims: [cleanup] })
    const stop = new AbortController()
    await t.daemon.loop(stop.signal)
    expect(existsSync(t.handoffPath)).toBe(false)
    expect(t.h.gitCalls).toEqual(['remove'])
    expect(t.events.filter((e) => e === 'claim')).toHaveLength(1)
    expect(t.exits).toEqual([75])
  })
})

describe('takeOverClaim', () => {
  const FRESH = NOW.toISOString()
  const STALE = new Date(NOW.getTime() - 60_000).toISOString()
  const hand = (work: unknown, claimedAt: string) => JSON.stringify({ work, claimed_at: claimedAt })
  const rows: {
    name: string
    write: (path: string) => void
    cancel?: boolean
    heartbeat: boolean
    carried: string[]
    logged: string
  }[] = [
    {
      name: 'a fresh start',
      write: (p) => writeFileSync(p, hand(START, FRESH)),
      heartbeat: true,
      carried: ['start plan-1'],
      logged: '',
    },
    {
      name: 'a fresh resume',
      write: (p) => writeFileSync(p, hand(RESUME, FRESH)),
      heartbeat: true,
      carried: ['resume build-1: INTERRUPTED'],
      logged: '',
    },
    {
      name: 'a heartbeat that cancels the run',
      write: (p) => writeFileSync(p, hand(START, FRESH)),
      cancel: true,
      heartbeat: true,
      carried: [],
      logged: 'board-cli: handoff discarded',
    },
    {
      name: 'a claim 60 s old',
      write: (p) => writeFileSync(p, hand(START, STALE)),
      heartbeat: false,
      carried: [],
      logged: '60 s',
    },
    {
      name: 'unparseable JSON',
      write: (p) => writeFileSync(p, '{nope'),
      heartbeat: false,
      carried: [],
      logged: 'parsed',
    },
    {
      name: 'a file that cannot be read',
      write: (p) => mkdirSync(p),
      heartbeat: false,
      carried: [],
      logged: 'read',
    },
    {
      name: 'a cleanup',
      write: (p) => writeFileSync(p, hand(cleanup, FRESH)),
      heartbeat: false,
      carried: [],
      logged: 'cleanup',
    },
  ]
  it.each(rows)('with $name', async (row) => {
    const t = setUp({ fingerprints: [START_CODE], cancel: row.cancel === true ? [RUN.id] : [] })
    row.write(t.handoffPath)
    const stop = new AbortController()
    const run = t.daemon.loop(stop.signal)
    await new Promise((done) => setTimeout(done, 50))
    stop.abort()
    await run
    expect(existsSync(t.handoffPath)).toBe(false)
    expect(t.h.calls.slice(0, row.carried.length)).toEqual(row.carried)
    expect(t.h.calls.length > 0).toBe(row.carried.length > 0)
    expect(t.events.some((e) => e.startsWith('heartbeat'))).toBe(row.heartbeat)
    if (row.heartbeat) expect(t.events[0]).toBe('heartbeat (stages so far: 0)')
    if (row.logged !== '')
      expect(t.log.some((l) => l.startsWith('board-cli: ') && l.includes(row.logged))).toBe(true)
    // In every row, the daemon then claims.
    expect(t.events.filter((e) => e !== 'claim:title').at(-1)).toBe('claim')
  })
})

describe('the title lane', () => {
  const TITLE_RUN = {
    ...RUN,
    id: '00000000-0000-4000-8000-0000000000a1',
    kind: 'title' as const,
    spec_version: null,
    spec: null,
    task: { ...RUN.task, description_md: '' },
  }
  const TITLE: Work = { kind: 'start', run: TITLE_RUN }
  const runEnds = (t: ReturnType<typeof setUp>) =>
    t.h.sent
      .filter((e) => e.type === 'run_end')
      .map((e) => ({ outcome: e.payload.outcome, reason: e.payload.reason }))

  it('asks for title runs in one loop and for the other kinds in the other', async () => {
    const t = setUp({ fingerprints: [START_CODE] })
    const stop = new AbortController()
    const run = t.daemon.loop(stop.signal)
    await new Promise((done) => setTimeout(done, 20))
    stop.abort()
    await run
    const kinds = new Set(t.asked.map((k) => JSON.stringify(k)))
    expect(kinds).toEqual(
      new Set([JSON.stringify(['spec', 'delivery']), JSON.stringify(['title', 'rephrase'])]),
    )
  })

  it('carries a title run out to a suggestion', async () => {
    const t = setUp({ fingerprints: [START_CODE], titleClaims: [TITLE] })
    expect(await t.daemon.runTitleOnce(never)).toBe('suggested')
    expect(t.h.calls).toEqual(['start title-1', 'end title-1 ok'])
    expect(runEnds(t)).toEqual([{ outcome: 'suggested', reason: undefined }])
  })

  it('does not hand a title claim on once the code moved: it ends "the runner stopped"', async () => {
    const t = setUp({ fingerprints: [START_CODE, MOVED, MOVED, MOVED], titleClaims: [TITLE] })
    expect(await t.daemon.runTitleOnce(never)).toBe('failed')
    expect(existsSync(t.handoffPath)).toBe(false)
    expect(t.h.calls).toEqual([])
    expect(runEnds(t)).toEqual([{ outcome: 'failed', reason: 'the runner stopped' }])
    expect(t.exits).toEqual([])
  })

  it('ends a title run in flight "the runner stopped" when the daemon stops', async () => {
    const t = setUp({ fingerprints: [START_CODE], titleClaims: [TITLE] })
    const stopping = new AbortController()
    stopping.abort()
    expect(await t.daemon.runTitleOnce(stopping.signal)).toBe('failed')
    expect(runEnds(t)).toEqual([{ outcome: 'failed', reason: 'the runner stopped' }])
  })

  it('sends no claim from either loop once the code moved, and exits 75', async () => {
    const t = setUp({ fingerprints: [START_CODE, MOVED, MOVED, MOVED] })
    const stop = new AbortController()
    await t.daemon.loop(stop.signal)
    expect(t.events.filter((e) => e.startsWith('claim'))).toEqual([])
    expect(t.exits).toEqual([75])
  })

  it('carries out a cleanup that returns after the code moved', async () => {
    const t = setUp({ fingerprints: [START_CODE, MOVED, MOVED, MOVED], titleClaims: [cleanup] })
    expect(await t.daemon.runTitleOnce(never)).toBe('cleaned')
    expect(t.h.gitCalls).toEqual(['remove'])
  })
})
