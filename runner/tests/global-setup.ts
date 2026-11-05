import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home: string | undefined

/** The suite never reaches the owner's ~/.aidp: every worker inherits this directory. */
export function setup(): void {
  home = mkdtempSync(join(tmpdir(), 'aidp-suite-'))
  process.env.BOARD_HOME = home
}

export function teardown(): void {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
}
