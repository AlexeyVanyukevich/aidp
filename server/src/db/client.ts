import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.js'

// int8 arrives as a string to avoid losing precision; every count here fits a JS number, and
// a string count is a bug waiting to be concatenated.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value))

/**
 * `onError` hears of an idle pooled connection the database ended — a restart. The pool has
 * already discarded it; without a listener, pg's `error` event would stop the process.
 */
export function createDb(
  connectionString: string,
  onError: (error: Error) => void = () => undefined,
): Kysely<Database> {
  const pool = new pg.Pool({ connectionString })
  pool.on('error', onError)
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
