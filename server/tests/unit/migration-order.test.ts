import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { migrationOrder } from '../../src/modules/approvals/migration-order.js'

interface Row {
  name: string
  file: string
  siblings: string[]
  tooEarly: boolean
  after: string | null
}
const rows = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/migration-order.json', import.meta.url), 'utf8'),
) as Row[]

describe('the migration ordering rule', () => {
  it.each(rows)('$name', ({ file, siblings, tooEarly, after }) => {
    expect(migrationOrder(file, siblings)).toEqual({ tooEarly, after })
  })
})
