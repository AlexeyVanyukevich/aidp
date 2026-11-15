import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const HOOK = join(ROOT, '.claude/hooks/gate-review-prompt.py')
const SKILL = join(ROOT, '.claude/skills/gate-review/SKILL.md')

const skillText = readFileSync(SKILL, 'utf8')
const closing = skillText.indexOf('\n---', 4)
const frontmatter = skillText.slice(0, closing + 4)
const body = skillText.slice(closing + 4).replace(/^\n/, '')

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-hook-'))
  temps.push(dir)
  return dir
}

/** A copy of the hook in a temporary `.claude/hooks/`, with no skill beside it. */
function hookWithoutSkill(): string {
  const hooks = join(tempDir(), '.claude/hooks')
  mkdirSync(hooks, { recursive: true })
  const hook = join(hooks, 'gate-review-prompt.py')
  cpSync(HOOK, hook)
  return hook
}

interface Case {
  name: string
  stdin: string
  boardRunId?: string
  hook: 'real' | 'without-skill'
  exit: number
  output: 'context' | 'none'
  stderr?: string
}

const matching = JSON.stringify({ prompt: 'review AIDP-169' })

const CASES: Case[] = [
  { name: 'a matching prompt', stdin: matching, hook: 'real', exit: 0, output: 'context' },
  {
    name: 'a matching prompt in a board run',
    stdin: matching,
    boardRunId: 'run-1',
    hook: 'real',
    exit: 0,
    output: 'none',
  },
  {
    name: 'a prompt that does not match',
    stdin: JSON.stringify({ prompt: 'review why the run failed' }),
    hook: 'real',
    exit: 0,
    output: 'none',
  },
  { name: 'stdin that is not JSON', stdin: 'not json', hook: 'real', exit: 0, output: 'none' },
  {
    name: 'a matching prompt with no SKILL.md',
    stdin: matching,
    hook: 'without-skill',
    exit: 1,
    output: 'none',
    stderr: 'SKILL.md',
  },
]

interface HookOutput {
  hookSpecificOutput: { hookEventName: string; additionalContext: string }
}

describe('gate-review-prompt.py', () => {
  it('the skill is hidden from the model', () => {
    expect(frontmatter).toMatch(/^disable-model-invocation: true$/m)
  })

  it.each(CASES)('$name', (c) => {
    const hook = c.hook === 'without-skill' ? hookWithoutSkill() : HOOK
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env['BOARD_RUN_ID']
    if (c.boardRunId !== undefined) env['BOARD_RUN_ID'] = c.boardRunId
    const result = spawnSync('python3', [hook], {
      input: c.stdin,
      cwd: tempDir(),
      env,
      encoding: 'utf8',
    })
    expect(result.status).toBe(c.exit)
    if (c.stderr !== undefined) expect(result.stderr).toContain(c.stderr)
    if (c.output === 'none') {
      expect(result.stdout).toBe('')
      return
    }
    const out = JSON.parse(result.stdout) as HookOutput
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    const context = out.hookSpecificOutput.additionalContext
    expect(context).toContain(body)
    expect(context).not.toContain('disable-model-invocation')
    expect(context).not.toContain('description:')
    expect(context).not.toContain('Skill tool')
  })
})
