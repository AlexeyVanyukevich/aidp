import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renumber, type ReorderInput } from '../../src/modules/tasks/task.reorder.js'

type Row = [string, ReorderInput[], Record<string, number>]

const t = (id: string, state: ReorderInput['state'], position: number, number: number) => ({
  id,
  state,
  position,
  number,
})

const CASES: Row[] = [
  ['an empty board', [], {}],
  [
    'fractional positions',
    [t('a', 'backlog', 0.75, 1), t('b', 'backlog', 0.5, 2), t('c', 'backlog', 3, 3)],
    { b: 1, a: 2, c: 3 },
  ],
  [
    'negative positions',
    [t('a', 'backlog', -4, 1), t('b', 'backlog', -10, 2), t('c', 'backlog', 0, 3)],
    { b: 1, a: 2, c: 3 },
  ],
  [
    'duplicate positions, broken by number',
    [t('a', 'ready', 1, 5), t('b', 'ready', 1, 2), t('c', 'ready', 1, 9)],
    { b: 1, a: 2, c: 3 },
  ],
  [
    'already normalised',
    [t('a', 'done', 1, 1), t('b', 'done', 2, 2), t('c', 'done', 3, 3)],
    { a: 1, b: 2, c: 3 },
  ],
  [
    'several states never mix',
    [
      t('a', 'backlog', 7, 1),
      t('b', 'done', 2, 2),
      t('c', 'backlog', 0.5, 3),
      t('d', 'done', 9, 4),
      t('e', 'failed', 4, 5),
      t('f', 'blocked', 0.1, 6),
    ],
    { c: 1, a: 2, b: 1, d: 2, e: 1, f: 1 },
  ],
]

describe('renumber', () => {
  it.each(CASES)('%s', (_name, tasks, expected) => {
    expect(Object.fromEntries(renumber(tasks))).toEqual(expected)
  })

  it('does not import from db/', () => {
    const source = readFileSync(
      new URL('../../src/modules/tasks/task.reorder.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/db\//)
  })
})
