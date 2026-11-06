import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUNNER_DIR, runnerCode } from '../../src/fingerprint.js'

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fp-'))
  mkdirSync(join(dir, 'src', 'sub'), { recursive: true })
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'tests'))
  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, 'src', 'a.ts'), 'a')
  writeFileSync(join(dir, 'src', 'sub', 'b.ts'), 'b')
  writeFileSync(join(dir, 'bin', 'board-cli'), '#!/bin/sh')
  writeFileSync(join(dir, 'tests', 't.ts'), 't')
  return dir
}

const rows: { name: string; edit: (dir: string) => void; changes: boolean }[] = [
  {
    name: 'a .ts file changes',
    edit: (d) => writeFileSync(join(d, 'src', 'a.ts'), 'a2'),
    changes: true,
  },
  {
    name: 'a .ts file is added in a subdirectory',
    edit: (d) => writeFileSync(join(d, 'src', 'sub', 'c.ts'), 'c'),
    changes: true,
  },
  {
    name: 'bin/board-cli changes',
    edit: (d) => writeFileSync(join(d, 'bin', 'board-cli'), 'x'),
    changes: true,
  },
  {
    name: 'a .DS_Store is added',
    edit: (d) => writeFileSync(join(d, 'src', '.DS_Store'), 'x'),
    changes: false,
  },
  {
    name: 'a foo.ts.swp is added',
    edit: (d) => writeFileSync(join(d, 'src', 'foo.ts.swp'), 'x'),
    changes: false,
  },
  {
    name: 'a tests file changes',
    edit: (d) => writeFileSync(join(d, 'tests', 't.ts'), 't2'),
    changes: false,
  },
  {
    name: 'a node_modules file is added',
    edit: (d) => writeFileSync(join(d, 'node_modules', 'x.ts'), 'x'),
    changes: false,
  },
]

describe('runnerCode', () => {
  it.each(rows)('$name', ({ edit, changes }) => {
    const dir = copy()
    const before = runnerCode(dir)
    edit(dir)
    expect(runnerCode(dir) !== before).toBe(changes)
  })

  it('ignores a second copy standing in for a worktree, and is stable', () => {
    const dir = copy()
    const other = mkdtempSync(join(tmpdir(), 'fp-'))
    cpSync(dir, other, { recursive: true })
    const before = runnerCode(dir)
    writeFileSync(join(other, 'src', 'a.ts'), 'changed')
    expect(runnerCode(dir)).toBe(before)
    expect(runnerCode(dir)).toBe(before)
  })

  it('finds only .ts files under the real runner/src', () => {
    const all = readdirSync(join(RUNNER_DIR, 'src'), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
    const bad = all.filter((f) => !f.endsWith('.ts'))
    expect(bad, `not a .ts file: ${bad.join(', ')}`).toEqual([])
  })
})
