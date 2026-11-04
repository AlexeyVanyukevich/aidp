import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAllowed, readApproved, readExcluded } from '../../src/phases/run-dir.js'

const ENTRIES = [{ path: 'a/migrations/004_x.ts', content: 'a => <b> & c\r\n\n' }]
const READERS = {
  readAllowed: {
    read: readAllowed,
    file: 'allowed-files.json',
    missing: null,
    good: ['a', 'b'] as unknown,
    shape: 'an array of strings',
  },
  readApproved: {
    read: readApproved,
    file: 'approved-migrations.json',
    missing: [],
    good: ENTRIES as unknown,
    shape: 'an array of { path, content } entries',
  },
  readExcluded: {
    read: readExcluded,
    file: 'excluded-paths.json',
    missing: [],
    good: ['a', 'b'] as unknown,
    shape: 'an array of strings',
  },
} as const

interface Row {
  name: string
  reader: keyof typeof READERS
  /** The file's text; `directory` puts a directory at its path, which exists but cannot be read. */
  content: string | null | 'directory'
  /** What the reader returns; `missing` is the reader's own value for a missing file. */
  result: unknown | 'missing' | { throws: string }
}

const CASES: Row[] = (Object.keys(READERS) as (keyof typeof READERS)[]).flatMap((reader) => {
  const { file, good, shape: shapeText } = READERS[reader]
  const invalid = { throws: `${file} is not valid JSON` }
  const shape = { throws: `${file} is not ${shapeText}` }
  return [
    { name: `${reader}: missing file`, reader, content: null, result: 'missing' },
    { name: `${reader}: a good list`, reader, content: JSON.stringify(good), result: good },
    { name: `${reader}: not json`, reader, content: 'not json', result: invalid },
    { name: `${reader}: a string`, reader, content: '"abc"', result: shape },
    { name: `${reader}: an object`, reader, content: '{}', result: shape },
    { name: `${reader}: an array of numbers`, reader, content: '[1]', result: shape },
    ...(reader === 'readApproved'
      ? [
          {
            name: `${reader}: plain strings (the old form)`,
            reader,
            content: '["a"]',
            result: shape,
          },
          {
            name: `${reader}: an entry without content`,
            reader,
            content: '[{"path":"a"}]',
            result: shape,
          },
          {
            name: `${reader}: a content that is not a string`,
            reader,
            content: '[{"path":"a","content":1}]',
            result: shape,
          },
        ]
      : [
          {
            name: `${reader}: entries instead of strings`,
            reader,
            content: JSON.stringify(ENTRIES),
            result: shape,
          },
        ]),
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
      if (typeof result === 'object' && result !== null && 'throws' in result)
        expect(() => read(dir)).toThrow(result.throws)
      else expect(read(dir)).toEqual(result === 'missing' ? missing : result)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
