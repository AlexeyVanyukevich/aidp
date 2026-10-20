export interface Config {
  databaseUrl: string
  port: number
  /** Always loopback: the board has no sign-in, so it must not be reachable from a network. */
  host: string
  /** Host names a request may be addressed to. Anything else is a DNS-rebinding attempt. */
  allowedHosts: string[]
  /** Shared with the runner; authenticates claim and heartbeat. */
  runnerKey: string
  logLevel: string
  prPollMs: number
  /** How long a claim waits for work before answering empty. */
  claimWaitMs: number
  /** How often the sweeper looks for lost runners and unanswered questions. */
  sweepMs: number
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`Invalid configuration: ${key} is required`)
  }
  return value
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid configuration: ${key} must be a positive integer, got "${raw}"`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const runnerKey = required(env, 'RUNNER_KEY')
  if (runnerKey.length < 32) {
    throw new Error('Invalid configuration: RUNNER_KEY must be at least 32 characters')
  }

  const allowedHosts = (env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '')
  if (allowedHosts.length === 0) {
    throw new Error('Invalid configuration: ALLOWED_HOSTS names no host')
  }

  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    port: positiveInt(env, 'PORT', 4100),
    host: '127.0.0.1',
    allowedHosts,
    runnerKey,
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    prPollMs: positiveInt(env, 'PR_POLL_MS', 180_000),
    claimWaitMs: positiveInt(env, 'CLAIM_WAIT_MS', 30_000),
    sweepMs: positiveInt(env, 'SWEEP_MS', 60_000),
  }
}
