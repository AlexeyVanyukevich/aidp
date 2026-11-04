import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readLinked, readLinkedStrict } from '../../src/linked.js'

describe('the strict reader of linked.json', () => {
  const ENTRY = { key: 'X', repo_path: '/r', path: '/p' }
  interface Row {
    name: string
    content: string | null
    result: unknown[] | 'throws'
  }
  const ROWS: Row[] = [
    { name: 'a missing file', content: null, result: [] },
    { name: 'a well-formed entry', content: JSON.stringify([ENTRY]), result: [ENTRY] },
    { name: 'not json', content: 'not json', result: 'throws' },
    { name: 'an object', content: '{}', result: 'throws' },
    { name: 'an entry without repo_path and path', content: '[{"key":"X"}]', result: 'throws' },
    {
      name: 'an entry whose path is a number',
      content: JSON.stringify([{ ...ENTRY, path: 1 }]),
      result: 'throws',
    },
  ]
  const dirWith = (content: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'linked-strict-'))
    if (content !== null) writeFileSync(join(dir, 'linked.json'), content)
    return dir
  }
  it.each(ROWS)('$name', ({ content, result }) => {
    const dir = dirWith(content)
    if (result === 'throws') expect(() => readLinkedStrict(dir)).toThrow('linked.json')
    else expect(readLinkedStrict(dir)).toEqual(result)
  })

  it('AC6: the lenient reader still returns [] for a file that is not json', () => {
    expect(readLinked(dirWith('not json'))).toEqual([])
  })
})
