import { describe, expect, it } from 'vitest'
import { hookToEvent } from '../../src/hooks/hook-event.js'

const ctx = { runId: 'r', phaseId: 'p', agent: 'builder' }

describe('hookToEvent', () => {
  it.each([
    [
      'an edit',
      {
        tool_name: 'Edit',
        tool_input: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' },
        tool_response: {},
      },
      { tool: 'Edit', target: 'src/a.ts', status: 'ok' },
    ],
    [
      'a command',
      { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: '' } },
      { tool: 'Bash', target: 'npm test', status: 'ok' },
    ],
    [
      'a search',
      { tool_name: 'Grep', tool_input: { pattern: 'retry' }, tool_response: {} },
      { tool: 'Grep', target: 'retry', status: 'ok' },
    ],
    [
      'a failed tool',
      { tool_name: 'Bash', tool_input: { command: 'false' }, tool_response: { is_error: true } },
      { status: 'error' },
    ],
    [
      'a long command, cut to 200 characters',
      { tool_name: 'Bash', tool_input: { command: 'x'.repeat(500) }, tool_response: {} },
      { target: 'x'.repeat(200) },
    ],
  ])('records %s as a tool call', (_name, input, expected) => {
    expect(hookToEvent('PostToolUse', input, ctx)).toMatchObject({
      type: 'tool_call',
      agent: 'builder',
      phase_id: 'p',
      ...expected,
    })
  })

  it('records a subagent under its own type', () => {
    expect(
      hookToEvent('SubagentStart', { agent_id: 'a1', agent_type: 'explorer' }, ctx),
    ).toMatchObject({
      type: 'subagent_start',
      agent: 'explorer',
      payload: { agent_id: 'a1' },
    })
    expect(hookToEvent('SubagentStop', { agent_id: 'a1', agent_type: 'explorer' }, ctx).type).toBe(
      'subagent_stop',
    )
  })

  it('keeps no more than 4 KiB of a tool’s input', () => {
    const event = hookToEvent(
      'PostToolUse',
      {
        tool_name: 'Write',
        tool_input: { file_path: 'a', content: 'y'.repeat(10_000) },
        tool_response: {},
      },
      ctx,
    )
    expect(JSON.stringify(event.payload).length).toBeLessThan(4_200)
  })
})
