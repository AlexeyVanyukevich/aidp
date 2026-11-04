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
  /** What the reader returns; `missing` is the reader's own value for a missing file. */
  result: string[] | 'missing' | 'throws'
}

const CASES: Row[] = (Object.keys(READERS) as (keyof typeof READERS)[]).flatMap((reader) => [
  { name: `${reader}: missing file`, reader, content: null, result: 'missing' },
  { name: `${reader}: an array of strings`, reader, content: '["a","b"]', result: ['a', 'b'] },
  { name: `${reader}: not json`, reader, content: 'not json', result: 'throws' },
  { name: `${reader}: a string`, reader, content: '"abc"', result: 'throws' },
  { name: `${reader}: an object`, reader, content: '{}', result: 'throws' },
  { name: `${reader}: an array of numbers`, reader, content: '[1]', result: 'throws' },
])

describe('the run directory’s list readers', () => {
  it.each(CASES)('$name', ({ reader, content, result }) => {
    const { read, file, missing } = READERS[reader]
    const dir = mkdtempSync(join(tmpdir(), 'rd-'))
    try {
      if (content !== null) writeFileSync(join(dir, file), content)
      if (result === 'throws') expect(() => read(dir)).toThrow(file)
      else expect(read(dir)).toEqual(result === 'missing' ? missing : result)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
