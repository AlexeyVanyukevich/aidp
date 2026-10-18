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
}

/** The spec's §6 call. `--setting-sources project` keeps the owner's plugins and hooks out. */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  return [
    '-p',
    input.prompt,
    '--session-id',
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
    ...(input.budgetUsd === null ? [] : ['--max-budget-usd', String(input.budgetUsd)]),
    '--include-partial-messages',
    '--output-format',
    'stream-json',
    '--verbose',
  ]
}
