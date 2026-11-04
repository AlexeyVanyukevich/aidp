import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fenceMigration, sameMigrationContent } from '../../src/migration-content.js'

interface FenceRow {
  name: string
  content: string
  fenced: string
}
const fenceRows = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/migration-fence.json', import.meta.url), 'utf8'),
) as FenceRow[]

interface SameRow {
  name: string
  a: string
  b: string
  same: boolean
}
const sameRows: SameRow[] = [
  { name: 'CRLF against LF', a: 'a\r\nb\r\n', b: 'a\nb\n', same: true },
  { name: 'no final newline against one', a: 'a\nb', b: 'a\nb\n', same: true },
  { name: 'no final newline against three', a: 'a\nb', b: 'a\nb\n\n\n', same: true },
  { name: 'a changed character', a: 'a\nb\n', b: 'a\nc\n', same: false },
  { name: 'an extra blank line in the middle', a: 'a\nb\n', b: 'a\n\nb\n', same: false },
  { name: 'different leading whitespace', a: 'a\n  b\n', b: 'a\nb\n', same: false },
]

describe('sameMigrationContent', () => {
  it.each(sameRows)('$name', ({ a, b, same }) => {
    expect(sameMigrationContent(a, b)).toBe(same)
  })
})

describe('fenceMigration', () => {
  it.each(fenceRows)('$name', ({ content, fenced }) => {
    expect(fenceMigration(content)).toBe(fenced)
  })
})
