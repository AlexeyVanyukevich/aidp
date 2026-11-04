import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readLinked, readLinkedStrict } from '../../src/linked.js'

describe('the strict reader of linked.json', () => {
  const ENTRY = { key: 'X', repo_path: '/r', path: '/p' }
  const INVALID = { throws: 'linked.json is not valid JSON' }
  const SHAPE = { throws: 'linked.json is not a list of checkouts' }
  interface Row {
    name: string
    /** The file's text; `directory` puts a directory at its path, which exists but cannot be read. */
    content: string | null | 'directory'
    result: unknown[] | { throws: string }
  }
  const ROWS: Row[] = [
    { name: 'a missing file', content: null, result: [] },
    { name: 'a well-formed entry', content: JSON.stringify([ENTRY]), result: [ENTRY] },
    { name: 'not json', content: 'not json', result: INVALID },
    { name: 'an object', content: '{}', result: SHAPE },
    { name: 'an entry without repo_path and path', content: '[{"key":"X"}]', result: SHAPE },
    {
      name: 'an entry whose path is a number',
      content: JSON.stringify([{ ...ENTRY, path: 1 }]),
      result: SHAPE,
    },
    {
      name: 'present but unreadable',
      content: 'directory',
      result: { throws: 'linked.json cannot be read' },
    },
  ]
  const dirWith = (content: string | null | 'directory') => {
    const dir = mkdtempSync(join(tmpdir(), 'linked-strict-'))
    if (content === 'directory') mkdirSync(join(dir, 'linked.json'))
    else if (content !== null) writeFileSync(join(dir, 'linked.json'), content)
    return dir
  }
  it.each(ROWS)('$name', ({ content, result }) => {
    const dir = dirWith(content)
    if ('throws' in result) expect(() => readLinkedStrict(dir)).toThrow(result.throws)
    else expect(readLinkedStrict(dir)).toEqual(result)
  })

  it('AC6: the lenient reader still returns [] for a file that is not json', () => {
    expect(readLinked(dirWith('not json'))).toEqual([])
  })
})
