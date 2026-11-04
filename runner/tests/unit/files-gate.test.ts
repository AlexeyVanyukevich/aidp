import { describe, expect, it } from 'vitest'
import {
  formatViolations,
  newlyChanged,
  violationsOf,
  type Changes,
  type Violation,
} from '../../src/files-gate.js'

const NOT_IN_PLAN = 'not in the plan'
const UNAPPROVED = 'a migration the owner has not approved'
const MIGRATION = 'server/src/db/migrations/004_x.ts'
const DIFFERS = 'a migration that differs from the one the owner approved'
const APPROVED = 'export const x = 1\n'
const approved = [{ path: MIGRATION, content: APPROVED }]

const changes = (over: Partial<Changes>): Changes => ({
  committed: [],
  uncommitted: [],
  excluded: [],
  allowed: ['src/retry.ts'],
  approvedMigrations: [],
  ...over,
})

interface Row {
  name: string
  input: Partial<Changes>
  expected: Violation[]
}

const ROWS: Row[] = [
  { name: 'an allowed path', input: { committed: ['src/retry.ts'] }, expected: [] },
  {
    name: 'an allowed non-ASCII path',
    input: { committed: ['docs/café.md'], allowed: ['docs/café.md'] },
    expected: [],
  },
  {
    name: 'a committed path outside the plan',
    input: { committed: ['src/extra.ts'] },
    expected: [{ path: 'src/extra.ts', reason: NOT_IN_PLAN, committed: true }],
  },
  {
    name: 'an uncommitted path outside the plan',
    input: { uncommitted: ['notes.txt'] },
    expected: [{ path: 'notes.txt', reason: NOT_IN_PLAN, committed: false }],
  },
  {
    name: 'an excluded uncommitted path',
    input: { uncommitted: ['.setup-cache'], excluded: ['.setup-cache'] },
    expected: [],
  },
  {
    name: 'an excluded path that is also committed',
    input: { committed: ['package-lock.json'], excluded: ['package-lock.json'] },
    expected: [{ path: 'package-lock.json', reason: NOT_IN_PLAN, committed: true }],
  },
  {
    name: 'a path both committed and uncommitted, reported once',
    input: { committed: ['src/extra.ts'], uncommitted: ['src/extra.ts'] },
    expected: [{ path: 'src/extra.ts', reason: NOT_IN_PLAN, committed: true }],
  },
  {
    name: 'a migration the plan lists that the owner did not approve',
    input: { committed: [MIGRATION], allowed: [MIGRATION] },
    expected: [{ path: MIGRATION, reason: UNAPPROVED, committed: true }],
  },
  {
    name: 'an approved migration',
    input: {
      committed: [MIGRATION],
      allowed: [MIGRATION],
      approvedMigrations: approved,
      worktreeFiles: { [MIGRATION]: APPROVED },
      headFiles: { [MIGRATION]: 'export const x = 1\r\n\n' },
    },
    expected: [],
  },
  {
    name: 'a migration registry the plan lists',
    input: {
      uncommitted: ['server/src/db/migrations/index.ts'],
      allowed: ['server/src/db/migrations/index.ts'],
    },
    expected: [],
  },
  {
    name: 'an approved migration changed in the worktree and not committed',
    input: {
      uncommitted: [MIGRATION],
      approvedMigrations: approved,
      worktreeFiles: { [MIGRATION]: 'export const x = 2\n' },
    },
    expected: [{ path: MIGRATION, reason: DIFFERS, committed: false }],
  },
  {
    name: 'an approved migration that matches in the worktree and differs at HEAD',
    input: {
      committed: [MIGRATION],
      approvedMigrations: approved,
      worktreeFiles: { [MIGRATION]: APPROVED },
      headFiles: { [MIGRATION]: 'export const x = 2\n' },
    },
    expected: [{ path: MIGRATION, reason: DIFFERS, committed: true }],
  },
  {
    name: 'an approved migration missing at HEAD',
    input: {
      committed: [MIGRATION],
      approvedMigrations: approved,
      worktreeFiles: { [MIGRATION]: APPROVED },
      headFiles: { [MIGRATION]: null },
    },
    expected: [{ path: MIGRATION, reason: DIFFERS, committed: true }],
  },
  {
    name: 'an approved migration missing from the worktree',
    input: { uncommitted: [MIGRATION], approvedMigrations: approved, worktreeFiles: {} },
    expected: [{ path: MIGRATION, reason: DIFFERS, committed: false }],
  },
  {
    name: 'an uncommitted approved migration that matches, with no HEAD copy',
    input: {
      uncommitted: [MIGRATION],
      approvedMigrations: approved,
      worktreeFiles: { [MIGRATION]: APPROVED },
    },
    expected: [],
  },
  {
    name: 'a deleted path outside the plan',
    input: { committed: ['old.ts'] },
    expected: [{ path: 'old.ts', reason: NOT_IN_PLAN, committed: true }],
  },
]

describe('violationsOf', () => {
  it.each(ROWS)('$name', ({ input, expected }) => {
    expect(violationsOf(changes(input))).toEqual(expected)
  })

  // AC4 and AC5: what setup wrote is excluded; a commit of it still counts.
  it('lets setup output stay out of the way while the build commits only plan files', () => {
    expect(
      violationsOf(
        changes({
          committed: ['src/retry.ts'],
          uncommitted: ['package-lock.json', '.setup-cache'],
          excluded: ['package-lock.json', '.setup-cache'],
        }),
      ),
    ).toEqual([])
  })
})

describe('newlyChanged', () => {
  it('holds the paths in the after list and not in the before list', () => {
    expect(newlyChanged(['a', 'b'], ['b', 'c', 'd'])).toEqual(['c', 'd'])
  })
})

describe('formatViolations', () => {
  const HASH = 'a'.repeat(40)
  const text = formatViolations(
    [
      { path: 'src/extra.ts', reason: NOT_IN_PLAN, committed: true },
      { path: 'notes.txt', reason: NOT_IN_PLAN, committed: false },
    ],
    HASH,
  )

  it('lists the paths sorted, each with its reason and whether it is committed', () => {
    expect(text.indexOf('notes.txt')).toBeLessThan(text.indexOf('src/extra.ts'))
    expect(text).toContain('`notes.txt` – not in the plan (uncommitted)')
    expect(text).toContain('`src/extra.ts` – not in the plan (committed)')
  })

  it('gives the commands with the full hash and no placeholder', () => {
    expect(text).toContain(`git checkout ${HASH} -- src/extra.ts`)
    expect(text).toContain('git rm src/extra.ts')
    expect(text).toContain('out_of_plan')
    expect(text).toContain('migration')
    expect(text).toContain('delete')
    expect(text).not.toMatch(/<merge-base>|<hash>|<path>/)
  })

  it('quotes a path a shell would split', () => {
    const quoted = formatViolations(
      [{ path: 'notes/ünï "q".txt', reason: NOT_IN_PLAN, committed: true }],
      HASH,
    )
    expect(quoted).toContain(`git checkout ${HASH} -- 'notes/ünï "q".txt'`)
  })
})

describe('formatViolations for a migration that differs', () => {
  const text = formatViolations(
    [{ path: MIGRATION, reason: DIFFERS, committed: true }],
    'a'.repeat(40),
  )
  it('says how to clear it and where the approved version is', () => {
    expect(text).toContain(`\`${MIGRATION}\` – ${DIFFERS} (committed)`)
    expect(text).toContain('write the approved content again with one Write')
    expect(text).toContain('kind `migration` and the whole new file')
    expect(text).toContain('<approved_migration>')
    expect(text).toContain("the guard's refusal")
  })
  it('holds no line of the approved content and does not send it back to the fork point', () => {
    expect(text).not.toContain(APPROVED.trim())
    expect(text).not.toContain('git checkout')
  })
  it('does not tell the builder to end its turn, since a Write clears it', () => {
    expect(text).not.toContain('end your turn')
  })
})
