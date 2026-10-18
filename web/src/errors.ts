import { ApiError } from './api'

interface SchemaIssue {
  instancePath?: unknown
  params?: { missingProperty?: unknown }
}

/**
 * The field a refusal is about: a service check's `details.field`, else the first schema issue.
 * The page words the problem itself; the server's `message` is for the log, never shown.
 */
export function invalidField(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.code !== 'validation_error') return undefined
  const field = error.details?.field
  if (typeof field === 'string') return field
  const issues = error.details?.issues
  const first = Array.isArray(issues) ? (issues[0] as SchemaIssue | undefined) : undefined
  if (typeof first?.instancePath === 'string' && first.instancePath !== '')
    return first.instancePath.slice(1).split('/')[0]
  const missing = first?.params?.missingProperty
  return typeof missing === 'string' ? missing : undefined
}

/** The request lost a race: what the page showed was stale, and it has been read again. */
export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'conflict'
}
