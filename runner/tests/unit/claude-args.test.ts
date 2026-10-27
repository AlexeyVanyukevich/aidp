import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addDirsOf, buildClaudeArgs } from '../../src/phases/claude-args.js'

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

  // Slice 2 spec §3, fact 4: a resume repeats the call's flags, and the role survives it.
  it('resumes a session with the answer as its prompt, every other flag repeated', () => {
    const start = buildClaudeArgs(BASE)
    const resume = buildClaudeArgs({ ...BASE, prompt: 'The owner answered', resume: true })
    expect(resume.slice(0, 4)).toEqual([
      '-p',
      'The owner answered',
      '--resume',
      '11111111-1111-4111-8111-111111111111',
    ])
    expect(resume).not.toContain('--session-id')
    expect(resume.slice(4)).toEqual(start.slice(4))
  })
})

describe('the linked checkouts', () => {
  const dirsIn = (args: string[]) =>
    args.flatMap((arg, i) => (arg === '--add-dir' ? [args[i + 1]] : []))

  it.each([
    ['a first process', {}],
    ['a resumed process', { resume: true }],
  ])('gives %s one --add-dir for each checkout', (_name, change) => {
    const args = buildClaudeArgs({
      ...BASE,
      ...change,
      addDirs: ['/w/run-linked/ZLC', '/w/run-linked/KIT'],
    })
    expect(dirsIn(args)).toEqual(['/w/run-linked/ZLC', '/w/run-linked/KIT'])
  })

  it.each([
    ['none given', {}],
    ['an empty list', { addDirs: [] }],
  ])('gives no --add-dir with %s', (_name, change) => {
    expect(buildClaudeArgs({ ...BASE, ...change })).not.toContain('--add-dir')
  })

  it('reads the checkouts from linked.json, and none when the run has no file', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'run-'))
    expect(addDirsOf(runDir)).toEqual([])
    writeFileSync(
      join(runDir, 'linked.json'),
      JSON.stringify([
        { key: 'A', path: '/p/A' },
        { key: 'B', path: '/p/B' },
      ]),
    )
    expect(addDirsOf(runDir)).toEqual(['/p/A', '/p/B'])
  })
})
