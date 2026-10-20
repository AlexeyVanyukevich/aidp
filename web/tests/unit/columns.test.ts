import { describe, expect, it } from 'vitest'
import {
  columns,
  dropPatch,
  formatUsd,
  positionBetween,
  shortModel,
  stepPatch,
} from '../../src/board/columns'
import type { TaskCard } from '../../src/types'

const card = (id: string, state: TaskCard['state'], position: number): TaskCard => ({
  id,
  key: id,
  title: id,
  state,
  position,
  phase: null,
  attempt: null,
  models: [],
  cost_usd: 0,
  cost_complete: true,
  pr_url: null,
  question_waiting: false,
})

describe('columns', () => {
  it('groups cards by state, each column in position order', () => {
    const grouped = columns([
      card('b', 'backlog', 2),
      card('a', 'backlog', 1),
      card('r', 'review', 1),
    ])
    expect(grouped.backlog.map((c) => c.id)).toEqual(['a', 'b'])
    expect(grouped.review.map((c) => c.id)).toEqual(['r'])
    expect(grouped.done).toEqual([])
  })
})

const backlog = [card('a', 'backlog', 1), card('b', 'backlog', 2), card('c', 'backlog', 3)]

describe('dropPatch', () => {
  it.each([
    ['onto the top of its own column', backlog[2]!, 'backlog', backlog[0], { position: 0 }],
    ['between two cards', backlog[2]!, 'backlog', backlog[1], { position: 1.5 }],
    ['to the end of its own column', backlog[0]!, 'backlog', undefined, { position: 4 }],
  ] as const)('reorders a card dropped %s', (_name, moved, target, before, patch) => {
    expect(dropPatch(moved, target, before, backlog)).toEqual(patch)
  })

  it('moves a card from Review to Done', () => {
    expect(dropPatch(card('r', 'review', 1), 'done', undefined, [])).toEqual({ state: 'done' })
  })

  it.each([
    ['Backlog to Ready', 'backlog', 'ready'],
    ['Running to Done', 'running', 'done'],
    ['Review to Backlog', 'review', 'backlog'],
  ] as const)('refuses a drag from %s', (_name, from, to) => {
    expect(dropPatch(card('x', from, 1), to, undefined, [])).toBeNull()
  })
})

// The buttons that stand in for a drag ask for the same positions a drop would.
describe('stepPatch', () => {
  it.each([
    ['the last card up, between the first two', backlog[2]!, 'up', { position: 1.5 }],
    ['the middle card up, above the first', backlog[1]!, 'up', { position: 0 }],
    ['the first card down, between the last two', backlog[0]!, 'down', { position: 2.5 }],
    ['the middle card down, below the last', backlog[1]!, 'down', { position: 4 }],
    ['the first card up', backlog[0]!, 'up', null],
    ['the last card down', backlog[2]!, 'down', null],
  ] as const)('moves %s', (_name, moved, direction, patch) => {
    expect(stepPatch(moved, backlog, direction)).toEqual(patch)
  })
})

describe('formatting', () => {
  it.each([
    ['claude-sonnet-4-5-20250929', 'sonnet'],
    ['claude-haiku-4-5-20251001', 'haiku'],
    ['claude-opus-4-1', 'opus'],
    ['something-else', 'something-else'],
  ])('shortModel(%s) → %s', (id, short) => {
    expect(shortModel(id)).toBe(short)
  })

  it.each([
    [0, '$0.00'],
    [0.004, '<$0.01'],
    [0.84, '$0.84'],
    [12.346, '$12.35'],
  ])('formatUsd(%s) → %s', (usd, text) => {
    expect(formatUsd(usd)).toBe(text)
  })

  it.each([
    [undefined, 1, 0],
    [1, undefined, 2],
    [1, 2, 1.5],
    [undefined, undefined, 1],
  ])('positionBetween(%s, %s) → %s', (prev, next, expected) => {
    expect(positionBetween(prev, next)).toBe(expected)
  })
})
