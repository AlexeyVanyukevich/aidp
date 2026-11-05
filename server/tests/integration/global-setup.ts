import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { createDb } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'

let container: StartedPostgreSqlContainer
let home: string | undefined

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
  }
}

interface GlobalSetupContext {
  provide: <K extends keyof import('vitest').ProvidedContext>(key: K, value: string) => void
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const databaseUrl = container.getConnectionUri()
  const db = createDb(databaseUrl)
  try {
    await runMigrations(db)
  } finally {
    await db.destroy()
  }
  provide('databaseUrl', databaseUrl)
  // After the container starts, so a failed start leaves no directory behind.
  home = mkdtempSync(join(tmpdir(), 'aidp-suite-'))
  process.env.BOARD_HOME = home
}

export async function teardown(): Promise<void> {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  await container?.stop()
}
