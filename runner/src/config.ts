import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

export interface RunnerConfig {
  boardUrl: string
  runnerKey: string
  runnerId: string
  claudeBin: string
  ghBin: string
  /** Worktrees and run directories live here, outside every repository. */
  home: string
  testTimeoutMs: number
  claimWaitMs: number
  heartbeatMs: number
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`Invalid configuration: ${key} must be a positive integer`)
  return value
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv): RunnerConfig {
  const runnerKey = env.RUNNER_KEY?.trim()
  if (runnerKey === undefined || runnerKey === '')
    throw new Error('Invalid configuration: RUNNER_KEY is required')
  return {
    boardUrl: (env.BOARD_URL?.trim() || 'http://127.0.0.1:4100').replace(/\/+$/, ''),
    runnerKey,
    runnerId: env.RUNNER_ID?.trim() || hostname(),
    claudeBin: env.CLAUDE_BIN?.trim() || 'claude',
    ghBin: env.GH_BIN?.trim() || 'gh',
    home: env.BOARD_HOME?.trim() || join(homedir(), '.ai-task-board'),
    testTimeoutMs: positiveInt(env, 'TEST_TIMEOUT_MS', 900_000),
    claimWaitMs: positiveInt(env, 'CLAIM_WAIT_MS', 30_000),
    heartbeatMs: positiveInt(env, 'HEARTBEAT_MS', 30_000),
  }
}
