import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { realExec } from '../../src/exec.js'
import { Git } from '../../src/git.js'
import { CLI_PATH } from '../../src/self.js'
import { targetRepository, useTestGitIdentity } from './target-repo.js'

function call(args: string[], input: object, env: Record<string, string>) {
  return spawnSync(CLI_PATH, args, {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    cwd: tmpdir(),
  })
}

describe('board-cli as a hook', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'))
  const env = {
    BOARD_URL: 'http://127.0.0.1:9', // nothing listens: the event must be buffered
    BOARD_RUN_TOKEN: 't',
    BOARD_RUN_ID: '00000000-0000-4000-8000-000000000001',
    BOARD_PHASE_ID: '00000000-0000-4000-8000-000000000002',
    BOARD_PHASE: 'build',
    BOARD_AGENT: 'builder',
    BOARD_RUN_DIR: runDir,
  }

  it('buffers a tool call when the board is unreachable, and exits 0 so the agent goes on', () => {
    const result = call(
      ['event', 'PostToolUse'],
      { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} },
      env,
    )
    expect(result.status).toBe(0)
    const buffered = readFileSync(join(runDir, 'events.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(buffered).toEqual([
      expect.objectContaining({ type: 'tool_call', tool: 'Bash', target: 'ls' }),
    ])
  })

  it('denies an edit outside the plan through stdout', () => {
    writeFileSync(join(runDir, 'allowed-files.json'), JSON.stringify(['src/retry.ts']))
    const result = call(
      ['guard'],
      { cwd: runDir, tool_name: 'Edit', tool_input: { file_path: join(runDir, 'src/other.ts') } },
      env,
    )
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('marks the run paused when the board pauses it, and then refuses every tool', () => {
    expect(existsSync(join(runDir, 'paused'))).toBe(false)
    const after = call(
      ['event', 'PostToolUse'],
      {
        tool_name: 'mcp__board__request_approval',
        tool_input: { question: 'Which?' },
        tool_response: [
          {
            type: 'text',
            text: 'Paused: the owner will answer on the board, and the answer will arrive as your next message. End your turn now.',
          },
        ],
      },
      env,
    )
    expect(after.status).toBe(0)
    expect(existsSync(join(runDir, 'paused'))).toBe(true)

    const refused = call(
      ['guard'],
      { cwd: runDir, tool_name: 'Read', tool_input: { file_path: join(runDir, 'x') } },
      env,
    )
    expect(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecisionReason).toBe(
      'The run is paused; end your turn.',
    )
    rmSync(join(runDir, 'paused'))
  })

  it('stays silent to allow', () => {
    const result = call(
      ['guard'],
      { cwd: runDir, tool_name: 'Bash', tool_input: { command: 'npm test' } },
      env,
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})

describe('board-cli feedback on a Bash call in Build', () => {
  beforeAll(useTestGitIdentity)

  /** A run directory and a worktree in which a Bash call has just created `notes.txt`. */
  async function setup(over: { allowed?: boolean; base?: string } = {}) {
    const { repo } = targetRepository()
    const worktree = join(mkdtempSync(join(tmpdir(), 'wt-')), 'run')
    await new Git(realExec, 'gh').prepareWorktree(repo, 'main', 'board/PAY-1-r1', worktree)
    writeFileSync(join(worktree, 'notes.txt'), 'x\n')
    const runDir = mkdtempSync(join(tmpdir(), 'run-'))
    if (over.allowed !== false)
      writeFileSync(join(runDir, 'allowed-files.json'), JSON.stringify(['src/retry.ts']))
    writeFileSync(join(runDir, 'base-branch.txt'), over.base ?? 'main')
    const env = {
      BOARD_URL: 'http://127.0.0.1:9',
      BOARD_RUN_TOKEN: 't',
      BOARD_RUN_ID: '00000000-0000-4000-8000-000000000001',
      BOARD_PHASE_ID: '00000000-0000-4000-8000-000000000002',
      BOARD_PHASE: 'build',
      BOARD_AGENT: 'builder',
      BOARD_RUN_DIR: runDir,
    }
    return { worktree, runDir, env }
  }
  const bash = (cwd: string) => ({
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'echo x > notes.txt' },
    tool_response: {},
  })
  const recorded = (runDir: string) => readFileSync(join(runDir, 'events.ndjson'), 'utf8')

  it('AC17: blocks with the report when the call left a file outside the plan', async () => {
    const { worktree, runDir, env } = await setup()
    const result = call(['event', 'PostToolUse'], bash(worktree), env)
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout) as { decision: string; reason: string }
    expect(output.decision).toBe('block')
    expect(output.reason).toContain('notes.txt')
    expect(recorded(runDir)).toContain('"tool":"Bash"')
  })

  interface Quiet {
    name: string
    input: (worktree: string) => object
    over?: { allowed?: boolean; base?: string }
    phase?: string
  }
  const QUIET: Quiet[] = [
    {
      name: 'the tool is Edit',
      input: (cwd) => ({ ...bash(cwd), tool_name: 'Edit', tool_input: { file_path: 'notes.txt' } }),
    },
    { name: 'the phase is verify', input: bash, phase: 'verify' },
    { name: 'the run directory has no allowed-files.json', input: bash, over: { allowed: false } },
    { name: 'origin/<base> cannot be read', input: bash, over: { base: 'nope' } },
  ]
  it.each(QUIET)('AC18: stays silent, records the event and exits 0 when $name', async (row) => {
    const { worktree, runDir, env } = await setup(row.over)
    const result = call(
      ['event', 'PostToolUse'],
      row.input(worktree),
      row.phase === undefined ? env : { ...env, BOARD_PHASE: row.phase },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(recorded(runDir)).toContain('tool_call')
  })

  it('stays silent when nothing outside the plan changed', async () => {
    const { worktree, runDir, env } = await setup()
    writeFileSync(join(runDir, 'allowed-files.json'), JSON.stringify(['notes.txt']))
    const result = call(['event', 'PostToolUse'], bash(worktree), env)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})
