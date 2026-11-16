import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { lineDiff } from '../../src/modules/specs/line-diff.js'

const lines = (n: number, prefix = 'l') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)
const swap = (list: string[], at: Record<number, string>) =>
  list.map((line, i) => at[i + 1] ?? line)

interface Row {
  name: string
  before: string
  after: string
  /** The unified diff, the empty string for equal texts, null for too large. */
  expected: string | null
}

const rows: Row[] = [
  { name: 'equal texts', before: 'a\nb', after: 'a\nb', expected: '' },
  {
    name: 'a changed line in the middle',
    before: lines(7).join('\n'),
    after: swap(lines(7), { 4: 'X' }).join('\n'),
    expected: ['@@ -2,5 +2,5 @@', ' l2', ' l3', '-l4', '+X', ' l5', ' l6'].join('\n'),
  },
  {
    name: 'an added first line',
    before: 'a\nb\nc',
    after: 'z\na\nb\nc',
    expected: ['@@ -1,2 +1,3 @@', '+z', ' a', ' b'].join('\n'),
  },
  {
    name: 'a removed last line',
    before: 'a\nb\nc\nd',
    after: 'a\nb\nc',
    expected: ['@@ -2,3 +2,2 @@', ' b', ' c', '-d'].join('\n'),
  },
  {
    name: 'two hunks more than 4 lines apart',
    before: lines(12).join('\n'),
    after: swap(lines(12), { 2: 'X', 10: 'Y' }).join('\n'),
    expected: [
      '@@ -1,4 +1,4 @@',
      ' l1',
      '-l2',
      '+X',
      ' l3',
      ' l4',
      '@@ -8,5 +8,5 @@',
      ' l8',
      ' l9',
      '-l10',
      '+Y',
      ' l11',
      ' l12',
    ].join('\n'),
  },
  {
    name: 'two changes exactly 4 lines apart share a hunk',
    before: lines(8).join('\n'),
    after: swap(lines(8), { 2: 'X', 7: 'Y' }).join('\n'),
    expected: [
      '@@ -1,8 +1,8 @@',
      ' l1',
      '-l2',
      '+X',
      ' l3',
      ' l4',
      ' l5',
      ' l6',
      '-l7',
      '+Y',
      ' l8',
    ].join('\n'),
  },
  {
    name: 'differing middles over the cell limit',
    before: lines(1001, 'a').join('\n'),
    after: lines(1001, 'b').join('\n'),
    expected: null,
  },
]

describe('lineDiff', () => {
  it.each(rows)('$name', ({ before, after, expected }) => {
    expect(lineDiff(before, after)).toBe(expected)
  })

  it('imports nothing from db/', () => {
    const source = readFileSync(
      new URL('../../src/modules/specs/line-diff.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toContain('db/')
  })
})
