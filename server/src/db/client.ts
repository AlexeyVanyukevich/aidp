import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.js'

// int8 arrives as a string to avoid losing precision; every count here fits a JS number, and
// a string count is a bug waiting to be concatenated.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value))

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  })
}
