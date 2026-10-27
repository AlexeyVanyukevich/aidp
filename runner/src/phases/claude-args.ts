import { readLinked } from '../linked.js'

export interface ClaudeArgsInput {
  prompt: string
  sessionId: string
  role: string
  model: string
  effort: string
  permissionMode: string
  tools: string[]
  agentsJson: string
  settingsPath: string
  mcpPath: string
  budgetUsd: number | null
  /** Linked checkouts the process may read outside its worktree: one `--add-dir` each. */
  addDirs?: string[]
  /** Continue `sessionId` with `prompt` as its next message, rather than start it. */
  resume?: boolean
}

/**
 * The spec's §6 call. `--setting-sources project` keeps the owner's plugins and hooks out. A
 * resume repeats every flag: the role, its tools and its model survive it only so (slice 2
 * spec, §3, fact 4).
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  return [
    '-p',
    input.prompt,
    input.resume === true ? '--resume' : '--session-id',
    input.sessionId,
    '--agents',
    input.agentsJson,
    '--agent',
    input.role,
    '--model',
    input.model,
    '--effort',
    input.effort,
    '--permission-mode',
    input.permissionMode,
    '--allowedTools',
    input.tools.join(','),
    '--settings',
    input.settingsPath,
    '--mcp-config',
    input.mcpPath,
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    ...(input.addDirs ?? []).flatMap((dir) => ['--add-dir', dir]),
    ...(input.budgetUsd === null ? [] : ['--max-budget-usd', String(input.budgetUsd)]),
    '--include-partial-messages',
    '--output-format',
    'stream-json',
    '--verbose',
  ]
}

/** The checkouts `linked.json` lists in the run directory; none for a run without links. */
export function addDirsOf(runDir: string): string[] {
  return readLinked(runDir).map((checkout) => checkout.path)
}
