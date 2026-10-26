import { fileURLToPath } from 'node:url'
import type { Kysely } from 'kysely'
import { Migrator, type Migration } from 'kysely/migration'
import { createDb } from './client.js'
import { migrations } from './migrations/index.js'
import type { Database } from './schema.js'

/** Applies every pending migration. A failure names the migration and carries the database's error. */
export async function runMigrations(
  db: Kysely<Database>,
  available: Record<string, Migration> = migrations,
): Promise<void> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => available } })
  const { error, results } = await migrator.migrateToLatest()
  const failed = (results ?? []).find((result) => result.status === 'Error')
  if (failed !== undefined) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown error')
    throw new Error(`Migration "${failed.migrationName}" failed: ${reason}`, { cause: error })
  }
  if (error) throw error
}

// `npm run migrate`. DATABASE_URL alone: creating tables needs no runner key.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required to run migrations')
  }
  const db = createDb(databaseUrl)
  try {
    await runMigrations(db)
    console.log('migrations applied')
  } finally {
    await db.destroy()
  }
}
