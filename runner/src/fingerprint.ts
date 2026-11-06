import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/** The runner directory, found from this module's own location (`src/fingerprint.ts`). */
export const RUNNER_DIR = realpathSync(join(import.meta.dirname, '..'))

/** Every `.ts` file under `dir`, as paths relative to `base`, in sorted order. */
function tsFiles(base: string, dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...tsFiles(base, path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(path.slice(base.length + 1))
  }
  return found
}

/**
 * The runner's code fingerprint: SHA-256 over the `.ts` files under `<runner>/src` and
 * `<runner>/bin/board-cli`, in sorted relative-path order, each as its path and its content.
 * Read from disk as it is; no git call, since the guard computes it on every tool call.
 */
export function runnerCode(dir: string = RUNNER_DIR): string {
  const root = realpathSync(dir)
  const files = [...tsFiles(root, join(root, 'src')), join('bin', 'board-cli')].sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(join(root, file)))
    hash.update('\0')
  }
  return hash.digest('hex')
}
