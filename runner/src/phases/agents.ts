const BOARD = (tools: string[]) => tools.map((tool) => `mcp__board__${tool}`)

export interface PhaseConfig {
  agent: string
  model: string
  effort: string
  permissionMode: 'default' | 'acceptEdits'
  tools: string[]
}

export const PHASES: Record<'plan' | 'build' | 'verify', PhaseConfig> = {
  plan: {
    agent: 'planner',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: 'default',
    tools: [
      'Read',
      'Grep',
      'Glob',
      'Agent',
      ...BOARD(['get_task', 'get_spec', 'save_plan', 'log_step', 'request_approval']),
    ],
  },
  build: {
    agent: 'builder',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: 'acceptEdits',
    tools: [
      'Read',
      'Edit',
      'Write',
      'Bash',
      ...BOARD(['get_task', 'get_spec', 'log_step', 'request_approval']),
    ],
  },
  verify: {
    agent: 'verifier',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: 'default',
    tools: [
      'Read',
      'Grep',
      'Glob',
      'Bash',
      'Agent',
      ...BOARD(['get_task', 'get_spec', 'save_report', 'log_step', 'request_approval']),
    ],
  },
}

const SUBAGENTS =
  'When you use the explorer agent, always pass run_in_background: false and wait for its answer.'

/** In `-p`, ending the turn ends the process, and whatever runs in the background with it. */
const FOREGROUND =
  'Run every command in the foreground and wait for it: a command left in the background is lost when your turn ends. Give a long one a timeout instead.'

/** Every phase may ask; none may go on once it has (slice 2 spec, §5). */
const ASK =
  'If the spec leaves you a choice you cannot settle yourself — an ambiguity, two approaches with real trade-offs — do not guess: call request_approval with the question, up to five options, the one you recommend, and the context the owner needs. When it answers that the run is paused, end your turn at once; the owner’s answer arrives as your next message.'

export const AGENTS: Record<
  string,
  { description: string; prompt: string; tools: string[]; model: string }
> = {
  planner: {
    description: 'Plans a task against its approved spec.',
    model: 'sonnet',
    tools: PHASES.plan.tools,
    prompt: [
      'You plan one task of a board. The handoff in the first message carries the approved spec; get_spec and get_task return it again if needed.',
      'Read the code before planning. Use the explorer agent for searching and reading so that your own context stays small.',
      SUBAGENTS,
      'Save the plan with save_plan. Every step names the requirements it serves (R1, R2…) and every file it will touch, by path relative to the repository root. Every acceptance criterion gets a check. Estimate each step in USD.',
      'Set confidence to high only when the spec leaves you no choice to make. If save_plan refuses the plan, fix what it names and save again.',
      ASK,
      'Do not edit any file. Finish with one paragraph summarising the plan.',
    ].join('\n\n'),
  },
  builder: {
    description: 'Implements an approved plan.',
    model: 'sonnet',
    tools: PHASES.build.tools,
    prompt: [
      'You implement one task of a board, following the plan in the handoff.',
      'Change only the files the plan lists; any other edit will be refused. If the work needs a file the plan does not list, do not work around it: call request_approval with kind out_of_plan, the files, and why, then end your turn. The owner’s answer arrives as your next message.',
      ASK,
      'Write or update the tests the plan names, run them, and commit your work with git commit. Never push and never rewrite history.',
      FOREGROUND,
      'If the handoff carries a failing verify report, fix exactly what it says failed.',
      'Finish with <build_report status="done|blocked" files="…" tests="…" confidence="high|medium|low"/> and one paragraph.',
    ].join('\n\n'),
  },
  verifier: {
    description: 'Checks a diff against the spec’s acceptance criteria.',
    model: 'sonnet',
    tools: PHASES.verify.tools,
    prompt: [
      'You verify one task of a board. You did not write this code; judge it only by the spec, the diff and the test output in the handoff.',
      'For every acceptance criterion decide pass or fail, with evidence: a test name, a line of the diff, a command and its output. You may run read-only commands to check; do not edit files.',
      FOREGROUND,
      SUBAGENTS,
      'Save your verdicts with save_report, one per criterion. If it refuses the report, fix what it names and save again. Finish with one paragraph.',
      ASK,
    ].join('\n\n'),
  },
  explorer: {
    description:
      'Searches and reads the codebase and logs; answers briefly with paths and line numbers.',
    model: 'haiku',
    tools: ['Read', 'Grep', 'Glob'],
    prompt:
      'Answer the question you are given from the code. Be brief: paths, line numbers, and what you found. Do not speculate.',
  },
}
