import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import pg from 'pg'
import { publish } from '../../src/shared/bus.js'
import { buildTestApp, closeTestDb, getTestDb } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

/**
 * What a PostgreSQL restart does to a running server: every connection it holds is ended. An
 * unhandled `error` from any of them would stop the process, which Vitest reports as a failure.
 */
async function endEveryOtherConnection(): Promise<void> {
  const client = new pg.Client({ connectionString: inject('databaseUrl') })
  await client.connect()
  await client.query(
    'select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database()',
  )
  await client.end()
}

describe('a PostgreSQL restart', () => {
  it('leaves the server answering, its pool and its bus working again', async () => {
    // Idle pooled connections are the ones whose error stopped the server.
    await Promise.all([1, 2, 3].map(() => sql`select pg_sleep(0.05)`.execute(getTestDb())))
    const resynced = app.bus.next('resync', 15_000)

    await endEveryOtherConnection()

    expect(await resynced).toEqual({ topic: 'resync' })
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(200)
    const received = app.bus.next('run.queued', 5_000)
    await publish(getTestDb(), { topic: 'run.queued', runId: 'after-restart' })
    expect(await received).toEqual({ topic: 'run.queued', runId: 'after-restart' })
  })
})
