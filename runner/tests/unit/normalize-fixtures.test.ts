import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StreamNormalizer } from '../../src/stream/normalize.js'
import type { RunnerEvent } from '../../src/contract.js'

const DIR = join(import.meta.dirname, '../fixtures/stream')
const lines = (name: string) =>
  readFileSync(join(DIR, `${name}.ndjson`), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)

function normalize(name: string) {
  const normalizer = new StreamNormalizer({ runId: 'r', phaseId: 'p', agent: 'planner' })
  const events: RunnerEvent[] = []
  for (const line of lines(name)) events.push(...normalizer.push(line))
  events.push(...normalizer.finish())
  return { normalizer, events }
}

function sumByModel(events: RunnerEvent[]) {
  const totals = new Map<
    string,
    { input: number; output: number; cache_read: number; cache_write: number }
  >()
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

describe.each(['plain', 'subagent'])('the %s recording', (name) => {
  const { normalizer, events } = normalize(name)
  const result = normalizer.result!

  it('ends with a result the normalizer kept', () => {
    expect(result).not.toBeNull()
    expect(normalizer.sessionId).toEqual(expect.any(String))
  })

  // Over-counting — the same message counted per content block — makes a sum exceed the total,
  // and the remainder line cannot be negative, so this equality fails.
  it('accounts for exactly what Claude Code counted, per model and counter', () => {
    const sums = sumByModel(events)
    for (const [model, usage] of Object.entries(result.modelUsage)) {
      expect(sums.get(model)).toEqual({
        input: usage.inputTokens,
        output: usage.outputTokens,
        cache_read: usage.cacheReadInputTokens,
        cache_write: usage.cacheCreationInputTokens,
      })
    }
  })

  it('attributes every cache token to a message, leaving only input and output unattributed', () => {
    const overhead = events.filter((e) => e.agent === 'claude-code')
    for (const e of overhead) {
      expect(e.usage.cache_read).toBe(0)
      expect(e.usage.cache_write).toBe(0)
    }
  })

  it('reports Claude Code’s own cost per model', () => {
    expect(normalizer.reportedCost()).toEqual(
      Object.fromEntries(Object.entries(result.modelUsage).map(([m, u]) => [m, u.costUSD])),
    )
  })
})

describe('the subagent recording', () => {
  it('puts the subagent’s usage under its own name, exactly as its result reported it', () => {
    const recorded = lines('subagent')
      .map(
        (l) =>
          l.tool_use_result as { agentType?: string; usage?: Record<string, number> } | undefined,
      )
      .find((r) => r?.agentType !== undefined)!
    const { events } = normalize('subagent')
    const event = events.find((e) => e.agent === recorded.agentType)!
    expect(event.usage).toEqual({
      input: recorded.usage!.input_tokens,
      output: recorded.usage!.output_tokens,
      cache_read: recorded.usage!.cache_read_input_tokens,
      cache_write: recorded.usage!.cache_creation_input_tokens,
    })
  })
})
