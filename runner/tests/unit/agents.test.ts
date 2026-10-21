import { describe, expect, it } from 'vitest'
import { AGENTS, PHASES } from '../../src/phases/agents.js'

// The fake claude calls the board's MCP server directly, past Claude Code's tool lists, so the
// scenarios cannot see a tool a phase is not allowed. This can (slice 2 spec, §5).
describe('the agents', () => {
  it.each(['plan', 'build', 'verify'] as const)('lets the %s phase ask the owner', (phase) => {
    expect(PHASES[phase].tools).toContain('mcp__board__request_approval')
    expect(AGENTS[PHASES[phase].agent]?.tools).toContain('mcp__board__request_approval')
  })

  it.each(['planner', 'builder', 'verifier'])(
    'tells the %s when to ask, and to stop after',
    (agent) => {
      const prompt = AGENTS[agent]!.prompt
      expect(prompt).toContain('request_approval')
      expect(prompt).toMatch(/end your turn/i)
    },
  )

  it('tells the builder to ask for a file the plan does not list, not to report it', () => {
    expect(AGENTS.builder!.prompt).toContain('kind out_of_plan')
    expect(AGENTS.builder!.prompt).not.toContain('say in your report which file')
  })
})
