import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fenceMigration, isFenced } from '../../src/modules/approvals/migration-content.js'

interface FenceRow {
  name: string
  content: string
  fenced: string
}
const fenceRows = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/migration-fence.json', import.meta.url), 'utf8'),
) as FenceRow[]

const fencedRows: { name: string; text: string; fenced: boolean }[] = [
  { name: 'a ts fence', text: '```ts\nx\n```', fenced: true },
  { name: 'a tilde fence', text: '~~~\nx\n~~~\n', fenced: true },
  { name: 'a fence only in the middle', text: 'a\n```\nx\n```\nb', fenced: false },
  { name: 'an opening fence never closed', text: '```ts\nx\ny', fenced: false },
  { name: 'a fence closed by the other character', text: '```\nx\n~~~', fenced: false },
  { name: 'a single fence line', text: '```', fenced: false },
  { name: 'plain text', text: 'export const x = 1\n', fenced: false },
]

describe('isFenced', () => {
  it.each(fencedRows)('$name', ({ text, fenced }) => {
    expect(isFenced(text)).toBe(fenced)
  })
})

describe('fenceMigration', () => {
  it.each(fenceRows)('$name', ({ content, fenced }) => {
    expect(fenceMigration(content)).toBe(fenced)
  })
})
