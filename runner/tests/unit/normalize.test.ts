import { describe, expect, it } from 'vitest'
import { StreamNormalizer } from '../../src/stream/normalize.js'

const u = (input: number, output: number, cr = 0, cw = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cw,
})
const start = (model: string, usage: object, parent: string | null = null) => ({
  type: 'stream_event',
  parent_tool_use_id: parent,
  event: { type: 'message_start', message: { id: 'm', model, usage } },
})
const delta = (usage: object, parent: string | null = null) => ({
  type: 'stream_event',
  parent_tool_use_id: parent,
  event: { type: 'message_delta', usage },
})
const result = (modelUsage: Record<string, object>, cost = 0) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  total_cost_usd: cost,
  modelUsage,
})
const mu = (i: number, o: number, cr = 0, cw = 0, costUSD = 0) => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadInputTokens: cr,
  cacheCreationInputTokens: cw,
  costUSD,
})

function run(lines: object[]) {
  const n = new StreamNormalizer({ runId: 'r', phaseId: 'p', agent: 'planner' })
  const events = lines.flatMap((l) => n.push(l))
  return { n, events: [...events, ...n.finish()] }
}

describe('StreamNormalizer', () => {
  it('takes a message’s output from its delta, not its start', () => {
    const { events } = run([start('m', u(10, 2, 100, 5)), delta(u(10, 250, 100, 5))])
    expect(events[0]).toMatchObject({
      type: 'message',
      agent: 'planner',
      model: 'm',
      usage: { input: 10, output: 250, cache_read: 100, cache_write: 5 },
    })
  })

  it('never reads usage from assistant events', () => {
    const assistant = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'm', model: 'm', usage: u(10, 4), content: [{ type: 'text', text: 'x' }] },
    }
    expect(run([assistant, assistant]).events).toEqual([])
  })

  it('names a synchronous subagent after its type', () => {
    const user = {
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] },
      tool_use_result: {
        status: 'completed',
        agentId: 'a1',
        agentType: 'explorer',
        resolvedModel: 'h',
        usage: u(2000, 60),
      },
    }
    expect(run([user]).events[0]).toMatchObject({
      agent: 'explorer',
      model: 'h',
      usage: { input: 2000, output: 60 },
      payload: { subagent_id: 'a1', tool_use_id: 'toolu_1' },
    })
  })

  it('leaves a background subagent to the remainder, since it reports no usage', () => {
    const user = {
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [] },
      tool_use_result: { status: 'async_launched', agentId: 'a1' },
    }
    const { events } = run([user, result({ h: mu(500, 20) })])
    expect(events).toEqual([
      expect.objectContaining({
        agent: 'claude-code',
        model: 'h',
        usage: { input: 500, output: 20, cache_read: 0, cache_write: 0 },
        payload: { unattributed: true },
      }),
    ])
  })

  it('uses the last result of a process, which is cumulative', () => {
    const { n, events } = run([
      result({ m: mu(10, 1, 0, 0, 0.01) }, 0.01),
      result({ m: mu(30, 3, 0, 0, 0.03) }, 0.03),
    ])
    expect(n.result?.totalCostUsd).toBe(0.03)
    expect(events[0]?.usage).toEqual({ input: 30, output: 3, cache_read: 0, cache_write: 0 })
  })

  it('writes no remainder when everything was attributed', () => {
    const { events } = run([start('m', u(10, 1)), delta(u(10, 5)), result({ m: mu(10, 5) })])
    expect(events.filter((e) => e.agent === 'claude-code')).toEqual([])
  })

  it('reads the session id from the init line', () => {
    const { n } = run([{ type: 'system', subtype: 'init', session_id: 's-1', model: 'm' }])
    expect(n.sessionId).toBe('s-1')
  })

  it('ignores stream events that belong to a subagent', () => {
    expect(run([start('m', u(1, 1), 'toolu_9'), delta(u(1, 9), 'toolu_9')]).events).toEqual([])
  })
})
