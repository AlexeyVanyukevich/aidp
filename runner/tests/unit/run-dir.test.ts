import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  /** The file's text; `directory` puts a directory at its path, which exists but cannot be read. */
  content: string | null | 'directory'
  /** What the reader returns; `missing` is the reader's own value for a missing file. */
  result: string[] | 'missing' | { throws: string }
}

const CASES: Row[] = (Object.keys(READERS) as (keyof typeof READERS)[]).flatMap((reader) => {
  const { file } = READERS[reader]
  const invalid = { throws: `${file} is not valid JSON` }
  const shape = { throws: `${file} is not an array of strings` }
  return [
    { name: `${reader}: missing file`, reader, content: null, result: 'missing' },
    { name: `${reader}: an array of strings`, reader, content: '["a","b"]', result: ['a', 'b'] },
    { name: `${reader}: not json`, reader, content: 'not json', result: invalid },
    { name: `${reader}: a string`, reader, content: '"abc"', result: shape },
    { name: `${reader}: an object`, reader, content: '{}', result: shape },
    { name: `${reader}: an array of numbers`, reader, content: '[1]', result: shape },
    {
      name: `${reader}: present but unreadable`,
      reader,
      content: 'directory',
      result: { throws: `${file} cannot be read` },
    },
  ]
})

describe('the run directory’s list readers', () => {
  it.each(CASES)('$name', ({ reader, content, result }) => {
    const { read, file, missing } = READERS[reader]
    const dir = mkdtempSync(join(tmpdir(), 'rd-'))
    try {
      if (content === 'directory') mkdirSync(join(dir, file))
      else if (content !== null) writeFileSync(join(dir, file), content)
      if (typeof result === 'object' && 'throws' in result)
        expect(() => read(dir)).toThrow(result.throws)
      else expect(read(dir)).toEqual(result === 'missing' ? missing : result)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
