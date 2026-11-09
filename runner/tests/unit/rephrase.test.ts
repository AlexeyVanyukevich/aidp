import { describe, expect, it } from 'vitest'
import type { RunWork, Work } from '../../src/contract.js'
import { AGENTS, PHASES } from '../../src/phases/agents.js'
import { buildClaudeArgs } from '../../src/phases/claude-args.js'
import { buildHandoff } from '../../src/phases/handoff.js'
import { rephraseDescription } from '../../src/rephrase.js'
import { RUN, harness } from './run-harness.js'

const REPHRASE_RUN: RunWork = {
  ...RUN,
  kind: 'rephrase',
  spec_version: null,
  spec: null,
  base_md: 'Retry <webhooks> when they fail.',
  task: { ...RUN.task, description_md: 'edited since', budget_usd: 2.5 },
}
const START: Extract<Work, { kind: 'start' }> = { kind: 'start', run: REPHRASE_RUN }

describe('the rephraser agent', () => {
  it('runs on Sonnet at medium effort in default mode with exactly its tools', () => {
    expect(PHASES.rephrase).toMatchObject({
      agent: 'rephraser',
      model: 'sonnet',
      effort: 'medium',
      permissionMode: 'default',
    })
    expect([...PHASES.rephrase.tools].sort()).toEqual(
      [
        'Read',
        'Grep',
        'Glob',
        'mcp__board__get_task',
        'mcp__board__save_suggestion',
        'mcp__board__log_step',
      ].sort(),
    )
    expect(AGENTS.rephraser?.tools).toEqual(PHASES.rephrase.tools)
    expect(AGENTS.rephraser?.model).toBe('sonnet')
  })

  it.each(['Edit', 'Write', 'Bash', 'Agent', 'mcp__board__request_approval'])(
    'has no %s',
    (tool) => {
      expect(PHASES.rephrase.tools).not.toContain(tool)
    },
  )

  it('is started with the model, effort, tools and budget the phase names', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      sessionId: 's',
      role: PHASES.rephrase.agent,
      model: PHASES.rephrase.model,
      effort: PHASES.rephrase.effort,
      permissionMode: PHASES.rephrase.permissionMode,
      tools: PHASES.rephrase.tools,
      agentsJson: '{}',
      settingsPath: '/s',
      mcpPath: '/m',
      budgetUsd: 2.5,
    })
    const after = (flag: string) => args[args.indexOf(flag) + 1]
    expect(after('--agent')).toBe('rephraser')
    expect(after('--model')).toBe('sonnet')
    expect(after('--effort')).toBe('medium')
    expect(after('--allowedTools')).toBe(PHASES.rephrase.tools.join(','))
    expect(after('--max-budget-usd')).toBe('2.5')
  })

  // One row per instruction the prompt must give.
  it.each([
    ['read the code the description touches', 'Read the code the description touches'],
    ['rewrite in clear sentences', 'Rewrite the description in clear sentences'],
    ['add the context left out', 'which parts of the code are involved'],
    ['say what they do today', 'what they do today'],
    ['say what the change touches', 'what the change touches'],
    ['keep the owner’s intent', 'Keep the owner’s intent'],
    ['decide nothing the owner did not', 'decide nothing the owner did not'],
    ['say where unsure', 'Where you are unsure, say so in the suggestion rather than guessing'],
    ['suggest the description only', 'never a new title, and never a spec'],
    ['change no file', 'You change no file'],
    ['save with save_suggestion', 'save_suggestion'],
    ['finish with one sentence', 'Finish with one sentence'],
  ])('tells the agent to %s', (_name, phrase) => {
    expect(AGENTS.rephraser!.prompt).toContain(phrase)
  })
})

describe('the rephrase handoff', () => {
  it('carries the key, the title, the description and the return format', () => {
    const text = buildHandoff({
      taskKey: 'PAY-7',
      title: 'Retry',
      phase: 'rephrase',
      attempt: 1,
      description: 'Retry <webhooks>',
      budgetUsd: null,
      summaries: [],
    })
    expect(text).toContain('<task id="PAY-7" phase="rephrase" attempt="1">Retry</task>')
    expect(text).toContain('<description>\nRetry &lt;webhooks&gt;\n</description>')
    expect(text).toContain(
      '<return_format>Call save_suggestion, then reply with one sentence.</return_format>',
    )
  })
})

describe('carrying a rephrase run out', () => {
  it('prepares a detached worktree, runs the one phase with the base text, and ends suggested', async () => {
    const h = harness({})
    expect(await rephraseDescription(START, h.deps)).toBe('suggested')
    expect(h.gitCalls[0]).toMatch(/^linked \/repo main /)
    expect(h.gitCalls.some((c) => c.startsWith('worktree '))).toBe(false)
    expect(h.gitCalls.some((c) => c.startsWith('push'))).toBe(false)
    expect(h.calls).toEqual(['start rephrase-1', 'end rephrase-1 ok'])
    expect(h.handoffs['rephrase-1']).toContain('Retry &lt;webhooks&gt; when they fail.')
    expect(h.handoffs['rephrase-1']).not.toContain('edited since')
    expect(h.handoffs['rephrase-1']).toContain('budget')
    expect(h.runEnd()?.payload).toMatchObject({ outcome: 'suggested' })
    expect(h.runEnd()?.payload).not.toHaveProperty('branch')
    expect(h.gitCalls).toContain('remove')
  })

  it('keeps no checkpoint, as it can never be resumed', async () => {
    const h = harness({})
    await rephraseDescription(START, h.deps)
    expect(h.checkpoints()).toEqual([])
  })

  it('ends failed, "the rephrase phase failed", when the phase fails, and removes the worktree', async () => {
    const h = harness({ acts: { 'rephrase-1': ['fails'] } })
    expect(await rephraseDescription(START, h.deps)).toBe('failed')
    expect(h.runEnd()?.payload).toMatchObject({
      outcome: 'failed',
      reason: 'the rephrase phase failed',
    })
    expect(h.gitCalls).toContain('remove')
  })

  it('ends failed, not blocked, when a git step fails', async () => {
    const h = harness({ fails: 'link' })
    expect(await rephraseDescription(START, h.deps)).toBe('failed')
    expect(h.runEnd()?.payload).toMatchObject({ outcome: 'failed' })
    expect(String(h.runEnd()?.payload.reason)).toContain('the rephrase run could not go on')
    expect(h.of('error').some((e) => e.payload.blocks === true)).toBe(false)
  })

  it('ends failed, "the runner stopped", when the daemon is stopping', async () => {
    const h = harness({ acts: { 'rephrase-1': ['shutdown'] } })
    expect(await rephraseDescription(START, h.deps)).toBe('failed')
    expect(h.runEnd()?.payload).toMatchObject({ outcome: 'failed', reason: 'the runner stopped' })
  })

  it('ends cancelled when the owner cancels', async () => {
    const h = harness({ acts: { 'rephrase-1': ['cancelled'] } })
    expect(await rephraseDescription(START, h.deps)).toBe('cancelled')
  })

  it('refuses a run of another kind', async () => {
    const h = harness({})
    const other: Extract<Work, { kind: 'start' }> = {
      kind: 'start',
      run: { ...REPHRASE_RUN, kind: 'title' },
    }
    expect(await rephraseDescription(other, h.deps)).toBe('failed')
    expect(h.calls).toEqual([])
  })
})
