import { inject } from 'vitest'
import { sql, type Kysely } from 'kysely'
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
