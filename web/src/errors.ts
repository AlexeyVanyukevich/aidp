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

export const NO_NOTE = 'Say what to change.'
export const NOTE_TOO_LONG = 'The note is longer than 4,000 characters.'

/** The note field's message for a Redraft the board refused, or undefined for any other failure. */
export function noteRefusal(error: unknown): string | undefined {
  if (invalidField(error) !== 'note') return undefined
  const issues = error instanceof ApiError ? error.details?.issues : undefined
  const issue = Array.isArray(issues)
    ? (issues[0] as { instancePath?: unknown; keyword?: unknown } | undefined)
    : undefined
  return issue?.instancePath === '/note' && issue.keyword === 'maxLength' ? NOTE_TOO_LONG : NO_NOTE
}
