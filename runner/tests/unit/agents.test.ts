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
    'mcp__board__list_projects',
    'mcp__board__list_tasks',
    'mcp__board__read_task',
    'mcp__board__propose_task',
    'mcp__board__list_proposals',
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

  it('tells the spec-writer to write only items under Requirements and Acceptance criteria', () => {
    const prompt = AGENTS['spec-writer']?.prompt ?? ''
    expect(prompt).toContain(
      'write only items, with no lead-in sentence, and indent a line that continues an item',
    )
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

  it('tells the builder which Bash commands may change files, and to delete generated ones', () => {
    const prompt = AGENTS.builder!.prompt
    expect(prompt).toContain('only with Edit and Write')
    expect(prompt).toContain('may change only the plan’s files, as a formatter does or git rm does')
    expect(prompt).toContain('undo such a change')
    expect(prompt).toContain('git checkout')
    expect(prompt).toContain('generated that the plan does not list')
    expect(prompt).toContain('is deleted, and never committed')
  })
})

interface PhraseRow {
  agent: string
  present: string[]
  absent: string[]
}
const PHRASES: PhraseRow[] = [
  {
    agent: 'verifier',
    present: [
      'withdrawn',
      'Withdrawn by the owner',
      'plan-gate answers',
      'the owner’s answer',
      'never goes back to Build',
    ],
    absent: ['judge it only by the spec, the diff and the test output'],
  },
  {
    agent: 'planner',
    present: [
      'withdrawn',
      'changed criterion',
      'quotes the owner’s',
      'no row in the checks table',
      'never has confidence high',
    ],
    absent: ['every acceptance criterion gets a check'],
  },
]

describe('the withdrawal wording', () => {
  it.each(PHRASES)('is in the $agent prompt', ({ agent, present, absent }) => {
    const prompt = AGENTS[agent]!.prompt.toLowerCase()
    for (const phrase of present) expect(prompt).toContain(phrase.toLowerCase())
    for (const phrase of absent) expect(prompt).not.toContain(phrase.toLowerCase())
  })
})

describe('the title phase', () => {
  it('runs title-writer on Sonnet at medium effort with exactly its tools', () => {
    expect(PHASES.title).toMatchObject({ agent: 'title-writer', model: 'sonnet', effort: 'medium' })
    expect([...PHASES.title.tools].sort()).toEqual(
      [
        'Read',
        'Grep',
        'Glob',
        'mcp__board__get_task',
        'mcp__board__suggest_title',
        'mcp__board__log_step',
      ].sort(),
    )
    expect(AGENTS['title-writer']?.tools).toEqual(PHASES.title.tools)
    expect(AGENTS['title-writer']?.model).toBe('sonnet')
  })

  it('has no way to edit, run a command, delegate or ask', () => {
    for (const tool of ['Edit', 'Write', 'Bash', 'Agent', 'mcp__board__request_approval'])
      expect(PHASES.title.tools).not.toContain(tool)
  })

  it('tells the agent to read the code, name it in its own terms, and suggest when unsure', () => {
    const prompt = AGENTS['title-writer']!.prompt
    expect(prompt).toContain('Read the code the task touches')
    expect(prompt).toContain('code’s own terms')
    expect(prompt).toContain('still suggest your best title')
  })
})

describe('the helper', () => {
  const helper = AGENTS.helper!

  it('reads and saves, on Opus at high effort, with exactly these tools', () => {
    expect(PHASES.help).toMatchObject({ agent: 'helper', model: 'opus', effort: 'high' })
    expect(helper.model).toBe('opus')
    expect(PHASES.help.tools.toSorted()).toEqual(
      [
        'Read',
        'Grep',
        'Glob',
        'mcp__board__get_task',
        'mcp__board__get_spec',
        'mcp__board__get_question',
        'mcp__board__get_decision',
        'mcp__board__get_phase_record',
        'mcp__board__list_projects',
        'mcp__board__list_tasks',
        'mcp__board__read_task',
        'mcp__board__save_help_result',
      ].toSorted(),
    )
    expect(helper.tools).toEqual(PHASES.help.tools)
    expect(PHASES.help.tools).not.toContain('mcp__board__request_approval')
  })

  it.each([
    ['answers one question', 'this one question only'],
    ['writes nothing', 'You write nothing'],
    [
      'says where it is unsure rather than guessing',
      'Say where you are unsure rather than guessing',
    ],
    ['in explain mode neither changes what is asked nor recommends', 'Do not change what is asked'],
    ['in explain mode carries no recommendation', 'no option and no recommendation'],
  ])('tells the helper it %s', (_name, words) => {
    expect(helper.prompt).toContain(words)
  })
})

describe('the board-reading tools', () => {
  const NEW = ['list_projects', 'list_tasks', 'read_task'].map((t) => `mcp__board__${t}`)
  const CURRENT = {
    build: [
      'Read',
      'Edit',
      'Write',
      'Bash',
      'mcp__board__get_task',
      'mcp__board__get_spec',
      'mcp__board__list_tasks',
      'mcp__board__read_task',
      'mcp__board__propose_task',
      'mcp__board__list_proposals',
      'mcp__board__log_step',
      'mcp__board__request_approval',
    ],
    verify: [
      'Read',
      'Grep',
      'Glob',
      'Bash',
      'Agent',
      'mcp__board__get_task',
      'mcp__board__get_spec',
      'mcp__board__list_tasks',
      'mcp__board__read_task',
      'mcp__board__propose_task',
      'mcp__board__list_proposals',
      'mcp__board__save_report',
      'mcp__board__log_step',
      'mcp__board__request_approval',
    ],
    title: [
      'Read',
      'Grep',
      'Glob',
      'mcp__board__get_task',
      'mcp__board__suggest_title',
      'mcp__board__log_step',
    ],
    rephrase: [
      'Read',
      'Grep',
      'Glob',
      'mcp__board__get_task',
      'mcp__board__save_suggestion',
      'mcp__board__log_step',
    ],
  } as const
  it.each(['spec', 'plan', 'help'] as const)('gives the %s phase the three tools', (phase) => {
    for (const tool of NEW) expect(PHASES[phase].tools).toContain(tool)
  })
  it.each(Object.entries(CURRENT))('leaves the %s phase’s tools as they were', (phase, tools) => {
    expect(PHASES[phase as keyof typeof CURRENT].tools).toEqual(tools)
  })

  it('tells the spec writer to read the board and name related tasks', () => {
    const prompt = AGENTS['spec-writer']!.prompt
    expect(prompt).toContain('list_tasks')
    expect(prompt).toContain('<linked_projects>')
    expect(prompt).toContain('project key')
    expect(prompt).toContain('## Context')
    expect(prompt).toContain('projects you searched')
  })
  it('tells the planner to read the board and say which tasks it takes in', () => {
    const prompt = AGENTS.planner!.prompt
    expect(prompt).toContain('list_tasks')
    expect(prompt).toContain('<linked_projects>')
    expect(prompt).toContain('takes in or leaves out')
  })
  it('tells the helper to check the board', () => {
    const prompt = AGENTS.helper!.prompt
    expect(prompt).toContain('read_task')
    expect(prompt).toContain('list_tasks')
    expect(prompt).toContain('whether a task exists')
  })
})

describe('proposing a finding', () => {
  const PROPOSE = ['propose_task', 'list_proposals'].map((t) => `mcp__board__${t}`)
  it.each(['spec', 'plan', 'build', 'verify'] as const)(
    'gives the %s phase the proposal tools',
    (phase) => {
      for (const tool of PHASES[phase].tools.length > 0 ? PROPOSE : [])
        expect(PHASES[phase].tools).toContain(tool)
    },
  )
  it.each(['build', 'verify'] as const)('gives the %s phase list_tasks and read_task', (phase) => {
    expect(PHASES[phase].tools).toContain('mcp__board__list_tasks')
    expect(PHASES[phase].tools).toContain('mcp__board__read_task')
  })
  it.each(['help', 'title', 'rephrase'] as const)(
    'keeps the proposal tools from the %s phase',
    (phase) => {
      for (const tool of PROPOSE) expect(PHASES[phase].tools).not.toContain(tool)
    },
  )
  it('keeps the proposal tools from a helper', async () => {
    const { HELP_TOOLS } = await import('../../src/hooks/guard.js')
    for (const tool of PROPOSE) expect(HELP_TOOLS.has(tool)).toBe(false)
  })

  interface Row {
    agent: string
    ends: string
    unrelated: boolean
  }
  const rows: Row[] = [
    { agent: 'spec-writer', ends: 'the closing paragraph', unrelated: false },
    { agent: 'planner', ends: 'the plan summary', unrelated: false },
    { agent: 'builder', ends: 'the build report’s paragraph', unrelated: true },
    { agent: 'verifier', ends: 'the verify report’s summary', unrelated: true },
  ]
  describe.each(rows)('the $agent’s prompt', ({ agent, ends, unrelated }) => {
    const prompt = AGENTS[agent]!.prompt
    it.each([
      'propose_task',
      'list_tasks',
      'list_proposals',
      'Where, Found, Problem, Impact',
      'task’s own project or in a project in <linked_projects>',
      'never with the board’s HTTP API',
      'the curl line in CLAUDE.md’s Findings rule is for sessions outside a run',
      `Name each proposal you made in ${ends}`,
      'once the cap refuses one, list the remaining findings there',
    ])('says %s', (words) => {
      expect(prompt).toContain(words)
    })
    it('never has the agent file a task itself', () => {
      expect(prompt).not.toMatch(
        /\b(file|filing) (an? (task|finding|proposal)|the (task|finding|proposal)|this (task|finding|proposal))/i,
      )
      expect(prompt).not.toMatch(/\byou (file|filed)\b/i)
    })
    it(
      unrelated ? 'says every finding is unrelated' : 'tells of the pause and the workaround',
      () => {
        if (unrelated) {
          expect(prompt).toContain('Every finding you propose is unrelated')
          expect(prompt).toContain('goes through request_approval')
        } else {
          expect(prompt).toContain('pauses the run until the owner settles it')
          expect(prompt).toContain('workaround_md')
        }
      },
    )
  })

  // Each row: a case, its verdict, and the clause of the verifier's prompt that settles it.
  const verifier: { case: string; verdict: 'passes' | 'fails'; clause: string }[] = [
    {
      case: 'an open proposal of this run matches',
      verdict: 'passes',
      clause: 'a matching proposal of any run of this task that is open or filed',
    },
    {
      case: 'a filed proposal of an earlier run matches',
      verdict: 'passes',
      clause: 'any run of this task',
    },
    {
      case: 'a task filed by hand is found by list_tasks',
      verdict: 'passes',
      clause: 'list_tasks finds a matching task in the target project',
    },
    {
      case: 'only a dismissed proposal matches',
      verdict: 'fails',
      clause: 'A dismissed proposal never counts',
    },
    { case: 'nothing matches', verdict: 'fails', clause: 'with neither the criterion fails' },
  ]
  it.each(verifier)('the verifier $verdict when $case', ({ clause }) => {
    expect(AGENTS.verifier!.prompt).toContain(clause)
    expect(AGENTS.verifier!.prompt).toContain('(outcome `file` or `workaround`)')
  })
  it('tells the helper how to advise on a proposal', () => {
    expect(AGENTS.helper!.prompt).toContain('advise:')
    expect(AGENTS.helper!.prompt).toContain('recommend one offered variant')
  })
})
