import { describe, expect, it } from 'vitest'
import { buildClaudeArgs } from '../../src/phases/claude-args.js'

const BASE = {
  prompt: '<task/>',
  sessionId: '11111111-1111-4111-8111-111111111111',
  role: 'builder',
  model: 'sonnet',
  effort: 'medium',
  permissionMode: 'acceptEdits',
  tools: ['Read', 'Edit'],
  agentsJson: '{"builder":{}}',
  settingsPath: '/run/settings.json',
  mcpPath: '/run/mcp.json',
  budgetUsd: null,
}

describe('buildClaudeArgs', () => {
  it('builds the spec’s one-phase call, flag for flag', () => {
    expect(buildClaudeArgs(BASE)).toEqual([
      '-p',
      '<task/>',
      '--session-id',
      '11111111-1111-4111-8111-111111111111',
      '--agents',
      '{"builder":{}}',
      '--agent',
      'builder',
      '--model',
      'sonnet',
      '--effort',
      'medium',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Read,Edit',
      '--settings',
      '/run/settings.json',
      '--mcp-config',
      '/run/mcp.json',
      '--strict-mcp-config',
      '--setting-sources',
      'project',
      '--include-partial-messages',
      '--output-format',
      'stream-json',
      '--verbose',
    ])
  })

  it('caps the phase’s spend when the task has a budget', () => {
    const args = buildClaudeArgs({ ...BASE, budgetUsd: 3 })
    expect(
      args.slice(args.indexOf('--max-budget-usd'), args.indexOf('--max-budget-usd') + 2),
    ).toEqual(['--max-budget-usd', '3'])
  })
})
