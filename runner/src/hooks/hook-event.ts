import type { RunnerEvent } from '../contract.js'
import { newEvent } from '../sink.js'

const MAX_INPUT = 4_096
/** The most of a Build's Bash output an event keeps: its end, where a test run says what failed. */
const MAX_OUTPUT_TAIL = 65_536

function target(input: Record<string, unknown>): string | null {
  for (const key of [
    'file_path',
    'notebook_path',
    'command',
    'pattern',
    'url',
    'path',
    'description',
  ]) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value.slice(0, 200)
  }
  return null
}

function failed(response: unknown): boolean {
  if (typeof response !== 'object' || response === null) return false
  const r = response as Record<string, unknown>
  return r.is_error === true || r.success === false || r.interrupted === true
}

/** A Bash call's stdout, then a newline and stderr when it has any, cut to its last characters. */
function outputTail(response: unknown): string | null {
  if (typeof response !== 'object' || response === null) return null
  const { stdout, stderr } = response as { stdout?: unknown; stderr?: unknown }
  const out = typeof stdout === 'string' ? stdout : ''
  const err = typeof stderr === 'string' ? stderr : ''
  const text = err === '' ? out : `${out}\n${err}`
  return text.length > MAX_OUTPUT_TAIL ? text.slice(-MAX_OUTPUT_TAIL) : text
}

export function hookToEvent(
  name: 'PostToolUse' | 'SubagentStart' | 'SubagentStop',
  input: Record<string, unknown>,
  ctx: { runId: string; phaseId: string; agent: string; phase?: string },
): RunnerEvent {
  const base = { runId: ctx.runId, phaseId: ctx.phaseId }
  if (name === 'PostToolUse') {
    const toolInput =
      typeof input.tool_input === 'object' && input.tool_input !== null
        ? (input.tool_input as Record<string, unknown>)
        : {}
    const serialized = JSON.stringify(toolInput)
    const phase = ctx.phase ?? process.env.BOARD_PHASE
    const tail =
      input.tool_name === 'Bash' && phase === 'build' ? outputTail(input.tool_response) : null
    return newEvent(
      {
        ...base,
        type: 'tool_call',
        agent: typeof input.agent_type === 'string' ? input.agent_type : ctx.agent,
      },
      {
        tool: typeof input.tool_name === 'string' ? input.tool_name : null,
        target: target(toolInput),
        status: failed(input.tool_response) ? 'error' : 'ok',
        payload: {
          tool_use_id: input.tool_use_id ?? null,
          input: serialized.length > MAX_INPUT ? `${serialized.slice(0, MAX_INPUT)}…` : toolInput,
          ...(tail === null ? {} : { output_tail: tail }),
        },
      },
    )
  }
  return newEvent(
    {
      ...base,
      type: name === 'SubagentStart' ? 'subagent_start' : 'subagent_stop',
      agent: typeof input.agent_type === 'string' ? input.agent_type : null,
    },
    { payload: { agent_id: input.agent_id ?? null } },
  )
}

/**
 * True when this hook input is the board pausing the run: a `request_approval` call that the
 * board answered with its pause (spec §5). The event hook then marks the run directory, and the
 * guard refuses every tool after it.
 */
export function pausedBy(input: Record<string, unknown>): boolean {
  if (input.tool_name !== 'mcp__board__request_approval') return false
  const response = input.tool_response
  if (!Array.isArray(response)) return false
  return response.some(
    (block: unknown) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string' &&
      (block as { text: string }).text.startsWith('Paused:'),
  )
}

/**
 * True when this hook input is the board accepting a help's result: a `save_help_result` call
 * answered with the success text, which begins `Saved.`. The event hook then marks the run
 * directory, so the runner knows the help saved. A refused or stale save answers otherwise.
 */
export function savedBy(input: Record<string, unknown>): boolean {
  if (input.tool_name !== 'mcp__board__save_help_result') return false
  const response = input.tool_response
  if (!Array.isArray(response)) return false
  return response.some(
    (block: unknown) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string' &&
      (block as { text: string }).text.startsWith('Saved.'),
  )
}
