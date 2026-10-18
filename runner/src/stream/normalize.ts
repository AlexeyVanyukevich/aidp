import { randomUUID } from 'node:crypto'
import type { RunnerEvent, Usage } from '../contract.js'
import { newEvent } from '../sink.js'

interface ApiUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUSD: number
}

export interface ResultInfo {
  text: string
  isError: boolean
  subtype: string
  totalCostUsd: number
  modelUsage: Record<string, ModelUsage>
}

type Line = Record<string, unknown>
const record = (value: unknown): Line | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Line) : undefined
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const toUsage = (u: ApiUsage | undefined): Usage => ({
  input: num(u?.input_tokens),
  output: num(u?.output_tokens),
  cache_read: num(u?.cache_read_input_tokens),
  cache_write: num(u?.cache_creation_input_tokens),
})

/**
 * Turns one `claude -p` process's stream-json into usage events, so that their sum per model is
 * exactly the `modelUsage` of the process's last result. See the plan's Task 16 for which line
 * carries what; the rules were read off recordings, not documentation.
 */
export class StreamNormalizer {
  sessionId: string | null = null
  result: ResultInfo | null = null
  private current: { model: string } | undefined
  private readonly attributed = new Map<string, Usage>()
  private readonly clock: () => Date
  private readonly newId: () => string

  constructor(
    private readonly options: {
      runId: string
      phaseId: string
      agent: string
      clock?: () => Date
      newId?: () => string
    },
  ) {
    this.clock = options.clock ?? (() => new Date())
    this.newId = options.newId ?? randomUUID
  }

  private emit(
    agent: string,
    model: string,
    usage: Usage,
    payload: Record<string, unknown>,
  ): RunnerEvent {
    const sum = this.attributed.get(model) ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 }
    this.attributed.set(model, {
      input: sum.input + usage.input,
      output: sum.output + usage.output,
      cache_read: sum.cache_read + usage.cache_read,
      cache_write: sum.cache_write + usage.cache_write,
    })
    return newEvent(
      { runId: this.options.runId, phaseId: this.options.phaseId, type: 'message', agent, model },
      { usage, payload },
      this.clock,
      this.newId,
    )
  }

  push(raw: unknown): RunnerEvent[] {
    const line = record(raw)
    if (line === undefined) return []
    switch (line.type) {
      case 'system':
        if (line.subtype === 'init' && typeof line.session_id === 'string')
          this.sessionId = line.session_id
        return []
      case 'stream_event': {
        if (line.parent_tool_use_id !== null && line.parent_tool_use_id !== undefined) return []
        const event = record(line.event)
        if (event?.type === 'message_start') {
          const message = record(event.message)
          this.current = { model: typeof message?.model === 'string' ? message.model : 'unknown' }
          return []
        }
        if (event?.type === 'message_delta' && this.current !== undefined) {
          const usage = toUsage(record(event.usage) as ApiUsage | undefined)
          const model = this.current.model
          this.current = undefined
          return [this.emit(this.options.agent, model, usage, {})]
        }
        return []
      }
      case 'user': {
        const result = record(line.tool_use_result)
        if (
          result === undefined ||
          typeof result.agentType !== 'string' ||
          record(result.usage) === undefined
        )
          return []
        const message = record(line.message)
        const content = Array.isArray(message?.content) ? message.content : []
        const toolResult = content.map(record).find((block) => block?.type === 'tool_result')
        return [
          this.emit(
            result.agentType,
            typeof result.resolvedModel === 'string' ? result.resolvedModel : 'unknown',
            toUsage(record(result.usage) as ApiUsage),
            {
              subagent_id: result.agentId ?? null,
              tool_use_id: toolResult?.tool_use_id ?? null,
            },
          ),
        ]
      }
      case 'result': {
        const usage = record(line.modelUsage) ?? {}
        const modelUsage: Record<string, ModelUsage> = {}
        for (const [model, value] of Object.entries(usage)) {
          const u = record(value) ?? {}
          modelUsage[model] = {
            inputTokens: num(u.inputTokens),
            outputTokens: num(u.outputTokens),
            cacheReadInputTokens: num(u.cacheReadInputTokens),
            cacheCreationInputTokens: num(u.cacheCreationInputTokens),
            costUSD: num(u.costUSD),
          }
        }
        this.result = {
          text: typeof line.result === 'string' ? line.result : '',
          isError: line.is_error === true,
          subtype: typeof line.subtype === 'string' ? line.subtype : 'unknown',
          totalCostUsd: num(line.total_cost_usd),
          modelUsage,
        }
        return []
      }
      default:
        return []
    }
  }

  /** The remainder per model: Claude Code's own calls and background subagents. */
  finish(): RunnerEvent[] {
    if (this.result === null) return []
    const events: RunnerEvent[] = []
    for (const [model, total] of Object.entries(this.result.modelUsage)) {
      const done = this.attributed.get(model) ?? {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
      }
      const rest: Usage = {
        input: Math.max(0, total.inputTokens - done.input),
        output: Math.max(0, total.outputTokens - done.output),
        cache_read: Math.max(0, total.cacheReadInputTokens - done.cache_read),
        cache_write: Math.max(0, total.cacheCreationInputTokens - done.cache_write),
      }
      if (rest.input + rest.output + rest.cache_read + rest.cache_write > 0) {
        events.push(this.emit('claude-code', model, rest, { unattributed: true }))
      }
    }
    return events
  }

  reportedCost(): Record<string, number> {
    return Object.fromEntries(
      Object.entries(this.result?.modelUsage ?? {}).map(([model, u]) => [model, u.costUSD]),
    )
  }
}
