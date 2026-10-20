import { randomUUID } from 'node:crypto'
import type { RunnerEvent, SessionTotals, Usage } from '../contract.js'
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
  turns: number
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

const ZERO: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 }

/**
 * Turns one `claude -p` process's stream-json into usage events, so that their sum per model is
 * exactly the `modelUsage` of the process's last result. See slice 1's plan, Task 16, for which
 * line carries what; the rules were read off recordings, not documentation.
 *
 * A resumed process reports its session's totals so far, not its own (slice 2 spec, §3). Its
 * normalizer is given the totals the session's previous result reported, its `baseline`, and
 * counts only what lies beyond them.
 */
export class StreamNormalizer {
  sessionId: string | null = null
  result: ResultInfo | null = null
  private current: { model: string; usage: Usage } | undefined
  private readonly attributed = new Map<string, Usage>()
  private readonly clock: () => Date
  private readonly newId: () => string

  constructor(
    private readonly options: {
      runId: string
      phaseId: string
      agent: string
      /** The session's totals as its previous process's result reported them. */
      baseline?: Record<string, SessionTotals>
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
          this.current = {
            model: typeof message?.model === 'string' ? message.model : 'unknown',
            usage: toUsage(record(message?.usage) as ApiUsage | undefined),
          }
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
          turns: num(line.num_turns),
          totalCostUsd: num(line.total_cost_usd),
          modelUsage,
        }
        return []
      }
      default:
        return []
    }
  }

  /**
   * What the stream left unsaid when the process ended. A message still open — its process
   * stopped before the message's `message_delta` — is recorded from its `message_start`, marked
   * `cut`: its output count there is a floor (slice 2 spec, §3, fact 9). Then the remainder per
   * model: Claude Code's own calls and background subagents, beyond the session's baseline.
   */
  finish(): RunnerEvent[] {
    const events: RunnerEvent[] = []
    if (this.current !== undefined) {
      const { model, usage } = this.current
      this.current = undefined
      events.push(this.emit(this.options.agent, model, usage, { cut: true }))
    }
    if (this.result === null) return events
    for (const [model, total] of Object.entries(this.result.modelUsage)) {
      const done = this.attributed.get(model) ?? ZERO
      const before = this.options.baseline?.[model] ?? { ...ZERO, usd: 0 }
      const rest: Usage = {
        input: Math.max(0, total.inputTokens - before.input - done.input),
        output: Math.max(0, total.outputTokens - before.output - done.output),
        cache_read: Math.max(0, total.cacheReadInputTokens - before.cache_read - done.cache_read),
        cache_write: Math.max(
          0,
          total.cacheCreationInputTokens - before.cache_write - done.cache_write,
        ),
      }
      if (rest.input + rest.output + rest.cache_read + rest.cache_write > 0) {
        events.push(this.emit('claude-code', model, rest, { unattributed: true }))
      }
    }
    return events
  }

  /** This process's share of Claude Code's own cost per model: its total less the baseline's. */
  reportedCost(): Record<string, number> {
    return Object.fromEntries(
      Object.entries(this.result?.modelUsage ?? {}).map(([model, u]) => [
        model,
        Math.max(0, u.costUSD - (this.options.baseline?.[model]?.usd ?? 0)),
      ]),
    )
  }

  /** The session's totals as this process's result reported them: the next process's baseline. */
  totals(): Record<string, SessionTotals> | null {
    if (this.result === null) return null
    return Object.fromEntries(
      Object.entries(this.result.modelUsage).map(([model, u]) => [
        model,
        {
          input: u.inputTokens,
          output: u.outputTokens,
          cache_read: u.cacheReadInputTokens,
          cache_write: u.cacheCreationInputTokens,
          usd: u.costUSD,
        },
      ]),
    )
  }

  /**
   * `claude --resume` found no conversation: Claude Code deleted it, or its first process was
   * killed before writing one (slice 2 spec, §3, facts 10 and 12).
   */
  get sessionGone(): boolean {
    return (
      this.result !== null &&
      this.result.isError &&
      this.result.subtype === 'error_during_execution' &&
      this.result.turns === 0
    )
  }
}
