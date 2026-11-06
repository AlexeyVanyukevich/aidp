import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardApi } from '../../src/api.js'
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
  cancel?: string[]
  now?: Date
}) {
  const h = withPlan(harness({}))
  const log: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => void log.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation((line: string) => void log.push(String(line)))
  const events: string[] = []
  const claims = [...(options.claims ?? [])]
  const reads = options.fingerprints
  let read = 0
  const api = {
    ...h.deps.api,
    claim: async () => {
      events.push('claim')
      await new Promise((done) => setTimeout(done, 2))
      return claims.shift() ?? null
    },
    heartbeat: async () => {
      events.push(`heartbeat (stages so far: ${h.calls.length})`)
      return { cancel: options.cancel ?? [], pause: [] }
    },
  } as unknown as BoardApi
  const exits: number[] = []
  const settles: number[] = []
  const handoffPath = join(h.home, 'handoff.json')
  const daemon = new Daemon(h.deps.config, {
    api,
    git: h.deps.git,
    phases: h.deps.phases,
    runTests: h.deps.runTests!,
    clock: () => options.now ?? NOW,
    fingerprint: () => {
      read += 1
      const value = reads[Math.min(read - 1, reads.length - 1)] ?? START_CODE
      if (value === UNREADABLE) throw new Error('ENOENT: no such file or directory')
      return value
    },
    exit: (status) => void exits.push(status),
    settle: async () => void settles.push(read),
    handoffPath,
  })
  return { h, daemon, log, events, exits, settles, handoffPath, reads: () => read }
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
    expect(t.events.at(-1)).toBe('claim')
  })
})
