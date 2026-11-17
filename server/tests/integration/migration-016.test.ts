import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { migrations } from '../../src/db/migrations/index.js'

beforeEach(resetDb)
afterAll(closeTestDb)

const migrator = () =>
  new Migrator({ db: getTestDb(), provider: { getMigrations: async () => migrations } })

afterEach(async () => {
  expect((await migrator().migrateToLatest()).error).toBeUndefined()
})

const columns = async () =>
  (
    await sql<{
      column_name: string
      is_nullable: string
    }>`select column_name, is_nullable from information_schema.columns where table_name = 'specs'`.execute(
      getTestDb(),
    )
  ).rows

describe('migration 016', () => {
  it('adds a nullable approval_note to specs, and down drops it', async () => {
    expect(await columns()).toContainEqual({ column_name: 'approval_note', is_nullable: 'YES' })
    expect((await migrator().migrateTo('015_review_shape')).error).toBeUndefined()
    expect((await columns()).map((c) => c.column_name)).not.toContain('approval_note')
  })
})
