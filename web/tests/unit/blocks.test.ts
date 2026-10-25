import { describe, expect, it } from 'vitest'
import { actionsFor, blockText, initialTab, stateAnnouncement } from '../../src/card/blocks'
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
    [{ cause: 'runner_stopped', stage: 'spec' }, 'The runner was stopped during the draft.'],
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
    // A draft is cancelled as a run is; its card goes back where it came from (slice 3, §4).
    ['spec_draft', null, { cancel: true }],
    ['spec_review', null, {}],
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

// What the card says when its state changes, whoever changed it (slice 3 spec, §11).
describe('stateAnnouncement', () => {
  it.each<[string, Parameters<typeof stateAnnouncement>[0], string]>([
    [
      'a move of a delivery run',
      { key: 'PAY-1', from: 'ready', to: 'running', latestVersion: null, draftFailure: null },
      'PAY-1 is now in Running.',
    ],
    [
      'a question arriving',
      {
        key: 'PAY-1',
        from: 'running',
        to: 'needs_approval',
        latestVersion: null,
        draftFailure: null,
      },
      'PAY-1 is now in Needs approval. PAY-1 has a question waiting in Approvals.',
    ],
    [
      'a draft finishing',
      { key: 'PAY-1', from: 'spec_draft', to: 'spec_review', latestVersion: 2, draftFailure: null },
      'PAY-1 is now in Spec review. v2 is ready to review.',
    ],
    [
      'a first draft failing',
      {
        key: 'PAY-1',
        from: 'spec_draft',
        to: 'backlog',
        latestVersion: null,
        draftFailure: 'the spec-writer saved no spec',
      },
      'PAY-1 is now in Backlog. The last draft did not finish: the spec-writer saved no spec.',
    ],
    [
      'a redraft failing',
      {
        key: 'PAY-1',
        from: 'spec_draft',
        to: 'spec_review',
        latestVersion: 1,
        draftFailure: 'the spec phase failed',
      },
      'PAY-1 is now in Spec review. The last draft did not finish: the spec phase failed.',
    ],
    [
      'a draft the owner cancelled',
      { key: 'PAY-1', from: 'spec_draft', to: 'backlog', latestVersion: null, draftFailure: null },
      'PAY-1 is now in Backlog.',
    ],
  ])('%s', (_name, change, text) => {
    expect(stateAnnouncement(change)).toBe(text)
  })
})
