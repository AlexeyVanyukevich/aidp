import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { ConfigurationError } from './config.js'

function refuse(name: string, value: string, reason: string): never {
  throw new ConfigurationError(
    `${name}=${value}: ${reason}; use an absolute path to an executable, or a bare name found on the runner's PATH`,
  )
}

/** Why `file` is not an executable regular file, or `null` when it is one. */
function problem(file: string): 'does not exist' | 'not a regular file' | 'not executable' | null {
  let stats
  try {
    stats = statSync(file)
  } catch {
    return 'does not exist'
  }
  if (!stats.isFile()) return 'not a regular file'
  try {
    accessSync(file, constants.X_OK)
  } catch {
    return 'not executable'
  }
  return null
}

/**
 * Accepts `value` when it is an absolute path to an executable file, or a bare name that an
 * absolute `PATH` entry holds as one. Never runs it; empty and relative entries are skipped.
 */
export function checkExecutable(name: string, value: string, path: string | undefined): void {
  if (value.includes('/')) {
    if (!isAbsolute(value)) refuse(name, value, 'relative path')
    const why = problem(value)
    if (why !== null) refuse(name, value, why)
    return
  }
  for (const entry of (path ?? '').split(':')) {
    if (entry === '' || !isAbsolute(entry)) continue
    if (problem(join(entry, value)) === null) return
  }
  refuse(name, value, "not found on the runner's PATH")
}
