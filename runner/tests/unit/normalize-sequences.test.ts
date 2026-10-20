import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StreamNormalizer } from '../../src/stream/normalize.js'
import type { RunnerEvent, SessionTotals } from '../../src/contract.js'

/**
 * One session's processes replayed as the runner replays them: a normalizer per process, the
 * baseline carried from each result to the next (slice 2 spec, §7). The recordings are §3's.
 */
const DIR = join(import.meta.dirname, '../fixtures/stream')
const lines = (name: string) =>
  readFileSync(join(DIR, `${name}.ndjson`), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)

interface Process {
  events: RunnerEvent[]
  normalizer: StreamNormalizer
  reported: Record<string, number>
}

function replay(names: string[]): Process[] {
  let baseline: Record<string, SessionTotals> = {}
  return names.map((name) => {
    const normalizer = new StreamNormalizer({ runId: 'r', phaseId: 'p', agent: 'worker', baseline })
    const events: RunnerEvent[] = []
    for (const line of lines(name)) events.push(...normalizer.push(line))
    events.push(...normalizer.finish())
    const reported = normalizer.reportedCost()
    baseline = normalizer.totals() ?? baseline
    return { events, normalizer, reported }
  })
}

type Counters = { input: number; output: number; cache_read: number; cache_write: number }
function sumByModel(events: RunnerEvent[]): Map<string, Counters> {
  const totals = new Map<string, Counters>()
  for (const e of events) {
    if (e.model === null) continue
    const t = totals.get(e.model) ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 }
    totals.set(e.model, {
      input: t.input + e.usage.input,
      output: t.output + e.usage.output,
      cache_read: t.cache_read + e.usage.cache_read,
      cache_write: t.cache_write + e.usage.cache_write,
    })
  }
  return totals
}

/** Claude Code's own calls: models no stream message names, which only the remainder counts. */
function ownCalls(processes: Process[]): Map<string, Counters> {
  const all = processes.flatMap((p) => p.events)
  const streamed = new Set(
    all.filter((e) => e.agent !== 'claude-code' && e.model !== null).map((e) => e.model),
  )
  return new Map([...sumByModel(all)].filter(([model]) => !streamed.has(model)))
}

const finalUsage = (process: Process, model: string) => {
  const u = process.normalizer.result?.modelUsage[model]
  return u === undefined
    ? undefined
    : {
        input: u.inputTokens,
        output: u.outputTokens,
        cache_read: u.cacheReadInputTokens,
        cache_write: u.cacheCreationInputTokens,
      }
}

describe('a session paused and resumed', () => {
  const processes = replay(['pause-1', 'pause-2'])
  const last = processes.at(-1)!

  it('counts, across both processes, exactly what Claude Code counted, per model and counter', () => {
    const sums = sumByModel(processes.flatMap((p) => p.events))
    for (const model of Object.keys(last.normalizer.result!.modelUsage))
      expect(sums.get(model)).toEqual(finalUsage(last, model))
  })

  it('reports, across both processes, the session’s own cost', () => {
    for (const [model, usage] of Object.entries(last.normalizer.result!.modelUsage)) {
      const reported = processes.reduce((sum, p) => sum + (p.reported[model] ?? 0), 0)
      expect(reported).toBeCloseTo(usage.costUSD, 10)
    }
  })

  it('records no cut message, since every process ended by itself', () => {
    expect(processes.flatMap((p) => p.events).some((e) => e.payload.cut === true)).toBe(false)
  })
})

describe.each([
  { name: 'stopped with SIGTERM', files: ['term-1', 'term-2'] },
  { name: 'stopped with SIGKILL', files: ['kill-1', 'kill-2'] },
  {
    name: 'paused, then stopped with SIGKILL, then resumed',
    files: ['chain-1', 'chain-2', 'chain-3'],
  },
])('a session $name', ({ files }) => {
  const processes = replay(files)
  const last = processes.at(-1)!

  it('counts Claude Code’s own calls once: what its final totals say', () => {
    for (const [model, counted] of ownCalls(processes))
      expect(counted).toEqual(
        finalUsage(last, model) ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      )
  })

  it('never records a negative count', () => {
    for (const e of processes.flatMap((p) => p.events))
      expect(
        Math.min(e.usage.input, e.usage.output, e.usage.cache_read, e.usage.cache_write),
      ).toBeGreaterThanOrEqual(0)
  })
})

describe('a process killed partway through a message', () => {
  it.each(['kill-1', 'chain-2'])('%s records the cut message from its message_start', (name) => {
    const [process] = replay([name])
    const cut = process!.events.filter((e) => e.payload.cut === true)
    expect(cut).toHaveLength(1)
    const starts = lines(name).filter(
      (l) =>
        l.type === 'stream_event' &&
        (l.event as { type?: string }).type === 'message_start' &&
        l.parent_tool_use_id == null,
    )
    const lastStart = (starts.at(-1)!.event as { message: { usage: { output_tokens: number } } })
      .message.usage
    expect(cut[0]!.usage.output).toBe(lastStart.output_tokens)
    expect(process!.normalizer.totals()).toBeNull()
  })
})

describe('a session that no longer exists', () => {
  it('reads as gone, with nothing to record', () => {
    const [, resumed] = replay(['gone-1', 'gone-2'])
    expect(resumed!.normalizer.sessionGone).toBe(true)
    expect(resumed!.events).toEqual([])
  })

  it.each(['pause-2', 'kill-2'])('does not read %s as gone', (name) => {
    const [process] = replay([name])
    expect(process!.normalizer.sessionGone).toBe(false)
  })
})
