import { describe, expect, it } from 'vitest'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { loadRunnerConfig } from '../../src/config.js'

const BASE = { RUNNER_KEY: 'k'.repeat(32) }

describe('loadRunnerConfig', () => {
  it('fills the defaults', () => {
    expect(loadRunnerConfig(BASE)).toEqual({
      boardUrl: 'http://127.0.0.1:4100',
      runnerKey: BASE.RUNNER_KEY,
      runnerId: hostname(),
      claudeBin: 'claude',
      ghBin: 'gh',
      home: join(homedir(), '.ai-task-board'),
      testTimeoutMs: 900_000,
      claimWaitMs: 30_000,
      heartbeatMs: 30_000,
    })
  })

  it('drops a trailing slash from the board URL', () => {
    expect(loadRunnerConfig({ ...BASE, BOARD_URL: 'http://127.0.0.1:4100/' }).boardUrl).toBe(
      'http://127.0.0.1:4100',
    )
  })

  it.each([
    ['no runner key', {}, /RUNNER_KEY/],
    ['a test timeout of zero', { ...BASE, TEST_TIMEOUT_MS: '0' }, /TEST_TIMEOUT_MS/],
  ])('refuses %s', (_name, env, message) => {
    expect(() => loadRunnerConfig(env)).toThrow(message)
  })
})
