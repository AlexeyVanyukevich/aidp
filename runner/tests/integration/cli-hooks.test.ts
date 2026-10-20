import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI_PATH } from '../../src/self.js'

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
