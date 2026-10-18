import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** `runner/bin/board-cli`, found by walking up from this file, wherever it is run from. */
function find(): string {
  let dir = import.meta.dirname
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'bin', 'board-cli')
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  throw new Error('bin/board-cli not found above src/self.ts')
}

export const CLI_PATH = find()
