const REMOVED = new Set(['RUNNER_KEY', 'DATABASE_URL', 'PORT'])

/**
 * The environment a child of the runner inherits: the runner's own, without the variables that
 * belong to the board (its key, its database, its port and every `BOARD_*`).
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (REMOVED.has(key) || key.startsWith('BOARD_')) continue
    result[key] = value
  }
  return result
}
