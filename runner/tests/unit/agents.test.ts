import { describe, expect, it } from 'vitest'
import { AGENTS, PHASES } from '../../src/phases/agents.js'

// The fake claude calls the board's MCP server directly, past Claude Code's tool lists, so the
// scenarios cannot see a tool a phase is not allowed. This can (slice 2 spec, §5).
describe('the agents', () => {
  it.each(['plan', 'build', 'verify'] as const)('lets the %s phase ask the owner', (phase) => {
    expect(PHASES[phase].tools).toContain('mcp__board__request_approval')
    expect(AGENTS[PHASES[phase].agent]?.tools).toContain('mcp__board__request_approval')
  })

  it.each(['planner', 'builder', 'verifier', 'spec-writer'])(
    'tells the %s when to ask, and to stop after',
    (agent) => {
      const prompt = AGENTS[agent]!.prompt
      expect(prompt).toContain('request_approval')
      expect(prompt).toMatch(/end your turn/i)
    },
  )

  it('tells the planner the limit on a plan’s length', () => {
    expect(AGENTS.planner!.prompt).toContain('20,000')
  })

  it('tells the planner a previous plan is a starting point to revise, not to carry out', () => {
    const prompt = AGENTS.planner!.prompt
    expect(prompt).toContain('<previous_plan>')
    expect(prompt).toContain('starting point')
    expect(prompt).toContain('Never carry it out')
    expect(prompt).toContain('accepted="no"')
    expect(prompt).toContain('never approved by the owner')
  })

  it('tells the planner to keep the owner’s plan gate answers', () => {
    const prompt = AGENTS.planner!.prompt
    expect(prompt).toContain('<plan_answer>')
    expect(prompt).toContain('keeps every correction')
    expect(prompt).toContain('names that correction and says why')
    expect(prompt).toContain('the newer one wins')
    expect(prompt).toContain('<plan_answers_left_out>')
  })

  it('tells the builder to follow the commit rules and never bypass hooks', () => {
    const prompt = AGENTS.builder!.prompt
    expect(prompt).toContain('CLAUDE.md')
    expect(prompt).toContain('splitting the work into commits')
    expect(prompt).toContain('Never bypass git hooks')
    expect(prompt).toContain('rewrite the message and commit again')
  })

  it('tells the builder a migration needs an approval', () => {
    expect(AGENTS.builder!.prompt).toContain('kind migration')
  })

  it('tells the builder to ask for a file the plan does not list, not to report it', () => {
    expect(AGENTS.builder!.prompt).toContain('kind out_of_plan')
    expect(AGENTS.builder!.prompt).not.toContain('say in your report which file')
  })
})

// Slice 3 spec §5: the spec-writer reads and asks; it writes nothing but the spec.
describe('the spec-writer', () => {
  const TOOLS = [
    'Read',
    'Grep',
    'Glob',
    'mcp__board__get_task',
    'mcp__board__get_spec',
    'mcp__board__save_spec',
    'mcp__board__log_step',
    'mcp__board__request_approval',
  ]

  it('drafts on Opus at high effort, with read tools and the board alone', () => {
    expect(PHASES.spec).toEqual({
      agent: 'spec-writer',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
      tools: TOOLS,
    })
    expect(AGENTS['spec-writer']).toMatchObject({ model: 'opus', tools: TOOLS })
  })

  it('asks every open question in one batch, saves, and leaves Open questions empty', () => {
    const prompt = AGENTS['spec-writer']!.prompt
    expect(prompt).toContain('kind questions')
    expect(prompt).toContain('save_spec')
    expect(prompt).toMatch(/leave .*Open questions.* empty/i)
  })

  // Task 4's recording: told only the sections' names, Opus bolded its ids, which the parser
  // does not read. The template, word for word, shows the form the lint reads.
  it('carries the Spec tab’s template word for word', () => {
    const prompt = AGENTS['spec-writer']!.prompt
    expect(prompt).toContain('## Requirements\n1. R1 – testable statement')
    expect(prompt).toContain('## Acceptance criteria\n- AC1 (R1): Given … When … Then …')
    expect(prompt).toContain('## Open questions')
  })

  it('tells the spec-writer to prefer checkable criteria and to mark the rest owner', () => {
    const prompt = AGENTS['spec-writer']!.prompt
    expect(prompt).toContain('(R3, owner)')
    expect(prompt).toContain('Prefer a criterion a run can check')
  })
})

describe('the owner check in the prompts', () => {
  it('tells the planner to name the hand check and what a run can still check', () => {
    const prompt = AGENTS.planner!.prompt
    expect(prompt).toContain('names the hand check the owner will do')
    expect(prompt).toContain('anything a run can still check')
  })

  it('tells the verifier which criteria take owner and that fail still applies', () => {
    const prompt = AGENTS.verifier!.prompt
    expect(prompt).toContain('owner check')
    expect(prompt).toContain('gets fail when you can see the work is wrong')
    expect(prompt).toContain('never gets pass')
    expect(prompt).toContain('not back to Build')
  })
})
