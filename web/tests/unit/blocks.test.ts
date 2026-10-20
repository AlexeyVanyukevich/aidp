import { describe, expect, it } from 'vitest'
import { actionsFor, blockText, initialTab } from '../../src/card/blocks'
import type { Block, TaskState } from '../../src/types'

describe('blockText', () => {
  // The words of the slice 2 spec's §8 table.
  it.each<[Block, string]>([
    [{ cause: 'runner_lost', stage: 'build' }, 'The runner stopped sending heartbeats.'],
    [
      {
        cause: 'step_failed',
        stage: 'push',
        command: 'git push -u origin board/PAY-1-r1',
        output: 'x',
      },
      'This step failed: git push -u origin board/PAY-1-r1',
    ],
    [{ cause: 'runner_stopped', stage: 'verify' }, 'The runner was stopped during Verify.'],
    [{ cause: 'runner_stopped', stage: 'tests' }, 'The runner was stopped during the tests.'],
    [
      { cause: 'runner_stopped', stage: 'pr' },
      'The runner was stopped while opening the pull request.',
    ],
    [
      { cause: 'approval_expired', stage: 'build' },
      'The question went unanswered for 48 hours. Answer it in Approvals.',
    ],
  ])('says why: %j', (block, text) => {
    expect(blockText(block)).toBe(text)
  })
})

describe('actionsFor', () => {
  const none = { markDone: false, resume: false, cancel: false, rerun: false }
  it.each<[TaskState, Block | null, Partial<typeof none>]>([
    ['backlog', null, {}],
    ['ready', null, { cancel: true }],
    ['running', null, { cancel: true }],
    ['needs_approval', null, { cancel: true }],
    ['blocked', { cause: 'runner_lost', stage: 'build' }, { resume: true, cancel: true }],
    ['blocked', { cause: 'step_failed', stage: 'push' }, { resume: true, cancel: true }],
    ['blocked', { cause: 'runner_stopped', stage: 'verify' }, { resume: true, cancel: true }],
    // An expired question is answered, not resumed past (spec §2).
    ['blocked', { cause: 'approval_expired', stage: 'build' }, { cancel: true }],
    ['review', null, { markDone: true }],
    ['failed', null, { rerun: true }],
    ['done', null, {}],
  ])('offers on a %s card (%j)', (state, block, offered) => {
    expect(actionsFor(state, block)).toEqual({ ...none, ...offered })
  })
})

describe('initialTab', () => {
  it.each<[TaskState, Block | null, string]>([
    ['needs_approval', null, 'approvals'],
    ['blocked', { cause: 'approval_expired', stage: 'build' }, 'approvals'],
    ['blocked', { cause: 'runner_lost', stage: 'build' }, 'spec'],
    ['running', null, 'spec'],
  ])('opens a %s card on its %s tab', (state, block, tab) => {
    expect(initialTab({ state, block })).toBe(tab)
  })
})
