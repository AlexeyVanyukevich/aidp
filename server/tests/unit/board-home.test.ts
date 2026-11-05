import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('runs with a temporary BOARD_HOME, not the owner’s ~/.aidp', () => {
  const home = process.env.BOARD_HOME
  expect(home).toBeDefined()
  expect(home!.startsWith(tmpdir())).toBe(true)
  expect(home).not.toBe(join(homedir(), '.aidp'))
})
