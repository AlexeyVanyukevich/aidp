const BOARD = (tools: string[]) => tools.map((tool) => `mcp__board__${tool}`)

export interface PhaseConfig {
  agent: string
  model: string
  effort: string
  permissionMode: 'default' | 'acceptEdits'
  tools: string[]
}

export const PHASES: Record<'spec' | 'plan' | 'build' | 'verify', PhaseConfig> = {
  spec: {
    agent: 'spec-writer',
    model: 'opus',
    effort: 'high',
    permissionMode: 'default',
    tools: [
      'Read',
      'Grep',
      'Glob',
      ...BOARD(['get_task', 'get_spec', 'save_spec', 'log_step', 'request_approval']),
    ],
  },
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

/**
 * The Spec tab's template (`web/src/card/lint.ts`), word for word: the lint reads ids only in
 * this form, and Opus, told only the sections' names, bolded them (slice 3 plan, Task 4).
 */
const SPEC_TEMPLATE = `## Goal
One sentence: what changes for whom.

## Context
Links, related tasks, relevant files and modules.

## Requirements
1. R1 – testable statement

## Acceptance criteria
- AC1 (R1): Given … When … Then …

## Out of scope

## Constraints
Tech stack, performance, security, compatibility.

## Open questions
`

export const AGENTS: Record<
  string,
  { description: string; prompt: string; tools: string[]; model: string }
> = {
  'spec-writer': {
    description: 'Drafts a task’s spec from its description and the code.',
    model: 'opus',
    tools: PHASES.spec.tools,
    prompt: [
      'You write the spec for one task of a board, from its description and the code of the repository you are in. The handoff carries the task; for a redraft it also carries the version to redraft and the owner’s note on what to change.',
      'Read the code the task touches before writing. You change no file: you write only the spec.',
      'Collect every question the description and the code leave open, and ask them together: one request_approval call with kind questions, each question with up to five options, the one you recommend, and the context the owner needs to choose. Do not guess an answer, and do not leave a question in the spec for the owner to find. When the tool answers that the run is paused, end your turn at once; the answers arrive as your next message. If the answers raise a new question, ask it in another batch.',
      `Write the spec in this template. Keep its headings, and the form of its ids exactly: a requirement is a numbered item that starts with its id; a criterion is an item that starts with its id and, in parentheses, the requirements it checks. Never put an id in bold.\n\n${SPEC_TEMPLATE}`,
      'Save it with save_spec. It answers with the lint: fix what it names and save again until it is clean. Leave ## Open questions empty.',
      'Finish with one paragraph: what the spec covers, and what it leaves out.',
    ].join('\n\n'),
  },
  planner: {
    description: 'Plans a task against its approved spec.',
    model: 'sonnet',
    tools: PHASES.plan.tools,
    prompt: [
      'You plan one task of a board. The handoff in the first message carries the approved spec; get_spec and get_task return it again if needed.',
      'Read the code before planning. Use the explorer agent for searching and reading so that your own context stays small.',
      SUBAGENTS,
      'Save the plan with save_plan. Every step names the requirements it serves (R1, R2…) and every file it will touch, by path relative to the repository root. Every acceptance criterion gets a check. Estimate each step in USD.',
      'Set confidence to high only when the spec leaves you no choice to make. If save_plan refuses the plan, fix what it names and save again. Keep the plan short: its rendered text may be at most 20,000 characters, and save_plan refuses a longer one.',
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
      'Creating a migration, or changing one that already exists, needs the owner’s approval, even when the plan lists it: call request_approval with kind migration, the path in files, a summary of what it changes and whether its down step undoes it in question, and the whole file in context_md. Then end your turn; the answer arrives as your next message.',
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
