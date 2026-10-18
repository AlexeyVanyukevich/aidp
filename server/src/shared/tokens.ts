import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { UnauthorizedError } from './errors.js'

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

export function bearer(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  return match?.[1]
}

/** Compares digests, so neither the length nor the content leaks through timing. */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  )
}

/** Every failure is the same `UnauthorizedError`: no hint whether the token exists. */
export async function resolveRunToken(
  db: Kysely<Database>,
  header: string | undefined,
  now: Date,
): Promise<{ runId: string; taskId: string }> {
  const token = bearer(header)
  if (token === undefined) throw new UnauthorizedError()
  const row = await db
    .selectFrom('run_tokens')
    .innerJoin('runs', 'runs.id', 'run_tokens.run_id')
    .select(['runs.id as runId', 'runs.task_id as taskId', 'run_tokens.expires_at'])
    .where('run_tokens.token_hash', '=', hashToken(token))
    .executeTakeFirst()
  if (row === undefined || row.expires_at <= now) throw new UnauthorizedError()
  return { runId: row.runId, taskId: row.taskId }
}
