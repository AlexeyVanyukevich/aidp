import { inject } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { buildApp, type AppDeps } from '../../src/app.js'
import type { Config } from '../../src/config.js'
import { createDb } from '../../src/db/client.js'
import type { Database } from '../../src/db/schema.js'

let cached: Kysely<Database> | undefined

export function getTestDb(): Kysely<Database> {
  cached ??= createDb(inject('databaseUrl'))
  return cached
}

export async function closeTestDb(): Promise<void> {
  await cached?.destroy()
  cached = undefined
}

export async function resetDb(): Promise<void> {
  await sql`truncate table events, phases, artifacts, approval_requests, run_tokens, runs,
    specs, tasks, projects, prices restart identity cascade`.execute(getTestDb())
}

export const TEST_RUNNER_KEY = 'r'.repeat(40)

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: inject('databaseUrl'),
    port: 0,
    host: '127.0.0.1',
    allowedHosts: ['localhost', '127.0.0.1'],
    runnerKey: TEST_RUNNER_KEY,
    logLevel: 'silent',
    prPollMs: 180_000,
    claimWaitMs: 0,
    ...overrides,
  }
}

/**
 * Built and made ready, so the bus is listening before a test waits on it. `extend` adds routes
 * a test needs before the app is sealed. `app.inject` sends `Host: localhost:80`, which the
 * host check allows.
 */
export async function buildTestApp(
  overrides: Partial<Omit<AppDeps, 'config' | 'db'>> & { config?: Partial<Config> } = {},
  extend?: (app: FastifyInstance) => void,
): Promise<FastifyInstance> {
  const { config, ...rest } = overrides
  const app = await buildApp({ config: testConfig(config), db: getTestDb(), ...rest })
  extend?.(app)
  await app.ready()
  return app
}
