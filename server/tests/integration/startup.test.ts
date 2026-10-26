import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { createDb } from '../../src/db/client.js'
import { migrations } from '../../src/db/migrations/index.js'
import { closeTestDb, getTestDb, TEST_RUNNER_KEY } from './helpers.js'
import { inject } from 'vitest'

afterAll(closeTestDb)

const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url))

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
    probe.on('error', reject)
  })

/** A database of its own, migrated up to `upTo` only, so the latest migration is pending. */
async function pendingDatabase(name: string, breakLatest: boolean): Promise<string> {
  await sql`create database ${sql.id(name)}`.execute(getTestDb())
  const url = new URL(inject('databaseUrl'))
  url.pathname = `/${name}`
  const db = createDb(url.toString())
  try {
    const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } })
    const { error } = await migrator.migrateTo('002_pause_and_resume')
    if (error) throw error
    // 003 adds `runs.note`: a column already there makes its `up` throw a database error.
    if (breakLatest) await sql`alter table runs add column note text`.execute(db)
  } finally {
    await db.destroy()
  }
  return url.toString()
}

const env = (databaseUrl: string, port: number) => ({
  ...process.env,
  DATABASE_URL: databaseUrl,
  RUNNER_KEY: TEST_RUNNER_KEY,
  PORT: String(port),
  LOG_LEVEL: 'error',
})

const applied = async (databaseUrl: string) => {
  const db = createDb(databaseUrl)
  try {
    const { rows } = await sql<{ name: string }>`select name from kysely_migration`.execute(db)
    return rows.map((row) => row.name)
  } finally {
    await db.destroy()
  }
}

const listening = async (port: number) =>
  fetch(`http://127.0.0.1:${port}/api/health`).then(
    (response) => response.ok,
    () => false,
  )

describe('starting the server', () => {
  it('applies a pending migration before it answers', async () => {
    const databaseUrl = await pendingDatabase('startup_pending', false)
    const port = await freePort()
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: SERVER_DIR,
      env: env(databaseUrl, port),
      stdio: 'ignore',
    })
    try {
      const deadline = Date.now() + 60_000
      while (!(await listening(port)) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 200))
      expect(await listening(port)).toBe(true)
      expect(await applied(databaseUrl)).toContain('003_drafted_specs')
    } finally {
      child.kill()
    }
  })

  it('exits without listening when a migration fails, naming it and the database’s error', () => {
    return (async () => {
      const databaseUrl = await pendingDatabase('startup_failing', true)
      const port = await freePort()
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
        cwd: SERVER_DIR,
        env: env(databaseUrl, port),
        encoding: 'utf8',
        timeout: 60_000,
      })
      expect(result.status).not.toBe(0)
      expect(result.status).not.toBeNull()
      const output = `${result.stdout}${result.stderr}`
      expect(output).toContain('003_drafted_specs')
      expect(output).toMatch(/note.*already exists/)
      expect(await listening(port)).toBe(false)
      expect(await applied(databaseUrl)).not.toContain('003_drafted_specs')
    })()
  })

  it('names the migration under `npm run migrate` too', async () => {
    const databaseUrl = await pendingDatabase('startup_migrate', true)
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/db/migrate.ts'], {
      cwd: SERVER_DIR,
      env: env(databaseUrl, 0),
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(result.status).not.toBe(0)
    const output = `${result.stdout}${result.stderr}`
    expect(output).toContain('003_drafted_specs')
    expect(output).toMatch(/note.*already exists/)
  })
})
