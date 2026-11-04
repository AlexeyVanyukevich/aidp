import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAllowed, readApproved, readExcluded } from '../../src/phases/run-dir.js'

const READERS = {
  readAllowed: { read: readAllowed, file: 'allowed-files.json', missing: null },
  readApproved: { read: readApproved, file: 'approved-migrations.json', missing: [] },
  readExcluded: { read: readExcluded, file: 'excluded-paths.json', missing: [] },
} as const

interface Row {
  name: string
  reader: keyof typeof READERS
  content: string | null
}

const CASES: Row[] = (Object.keys(READERS) as (keyof typeof READERS)[]).flatMap((reader) => [
  { name: `${reader}: missing file`, reader, content: null },
  { name: `${reader}: an array of strings`, reader, content: '["a","b"]' },
  { name: `${reader}: not json`, reader, content: 'not json' },
  { name: `${reader}: a string`, reader, content: '"abc"' },
  { name: `${reader}: an object`, reader, content: '{}' },
  { name: `${reader}: an array of numbers`, reader, content: '[1]' },
])

describe('the run directory’s list readers', () => {
  it.each(CASES)('$name', ({ reader, content }) => {
    const { read, file, missing } = READERS[reader]
    const dir = mkdtempSync(join(tmpdir(), 'rd-'))
    try {
      if (content !== null) writeFileSync(join(dir, file), content)
      if (content === null) expect(read(dir)).toEqual(missing)
      else if (content === '["a","b"]') expect(read(dir)).toEqual(['a', 'b'])
      else expect(() => read(dir)).toThrow(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
