import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { showsOnlyLoadFailure } from '../../src/modules/mcp/load-failure.js'

const MISSING = "Error: Cannot find module '../../src/x.js'"
const EXPORT = "SyntaxError: The requested module './x.js' does not provide an export named 'y'"

const ROWS: { name: string; line: string; load: boolean }[] = [
  { name: 'a bare missing module', line: MISSING, load: true },
  { name: 'after FAIL', line: `FAIL ${MISSING}`, load: true },
  { name: 'after ×', line: `× ${MISSING}`, load: true },
  { name: 'after ✗', line: `✗ ${MISSING}`, load: true },
  { name: 'after ❯', line: `❯ ${MISSING}`, load: true },
  { name: 'after leading space', line: `   ${MISSING}`, load: true },
  { name: 'a missing export', line: EXPORT, load: true },
  {
    name: 'a missing module inside an assertion message',
    line: "AssertionError: expected 'a' to contain 'Cannot find module'",
    load: false,
  },
  { name: 'is not a function', line: 'TypeError: added is not a function', load: false },
  {
    name: 'a module error without the export words',
    line: "SyntaxError: The requested module './x.js'",
    load: false,
  },
  { name: 'two markers', line: `FAIL × ${MISSING}`, load: false },
]

describe('showsOnlyLoadFailure', () => {
  it.each(ROWS)('$name', ({ line, load }) => {
    expect(showsOnlyLoadFailure(line)).toBe(load)
  })

  it('imports nothing from db/', () => {
    const source = readFileSync(
      new URL('../../src/modules/mcp/load-failure.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/db\//)
  })
})
