import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/api'
import {
  arrivals,
  outcomeText,
  proposalHelp,
  proposalHelpAnnouncement,
  settledText,
  settleProblem,
  variantLabel,
} from '../../src/card/ProposalsTab'
import type { HelpView, ProposalView } from '../../src/types'

// The kit's published build cannot load in Node here; these tests use only the tab's pure parts.
vi.mock('@zellige/react', () => ({
  Badge: () => null,
  Button: () => null,
  Card: () => null,
  Empty: () => null,
  Markdown: () => null,
}))
vi.mock('react-router', () => ({ Link: () => null }))

const proposal = (overrides: Partial<ProposalView> = {}): ProposalView => ({
  id: 'p1',
  run: { kind: 'delivery', number: 1 },
  phase: 'build',
  number: 1,
  project: 'AIDP',
  title: 'Radio cannot be unticked',
  description_md: 'd',
  related: false,
  bearing_md: null,
  workaround_md: null,
  offered: ['file', 'dismiss'],
  outcome: null,
  filed_task: null,
  created_at: '2026-11-12T10:00:00Z',
  settled_at: null,
  ...overrides,
})

describe('variantLabel', () => {
  it.each([
    { variant: 'file', label: 'File in AIDP' },
    { variant: 'workaround', label: 'Use the workaround and file in AIDP' },
    { variant: 'dismiss', label: 'Dismiss' },
  ] as const)('$variant', ({ variant, label }) => expect(variantLabel(variant, 'AIDP')).toBe(label))
})

describe('outcomeText', () => {
  it.each([
    { outcome: null, text: 'open' },
    { outcome: 'file', text: 'filed' },
    { outcome: 'workaround', text: 'filed with workaround' },
    { outcome: 'dismiss', text: 'dismissed' },
  ] as const)('$outcome', ({ outcome, text }) => expect(outcomeText(outcome)).toBe(text))
})

describe('settledText', () => {
  const key = { id: 't', key: 'AIDP-7', title: 'x' }
  it.each([
    { outcome: 'file', filed: key, text: 'Filed AIDP-7: Radio cannot be unticked.' },
    {
      outcome: 'workaround',
      filed: key,
      text: 'Filed AIDP-7 with the workaround: Radio cannot be unticked.',
    },
    { outcome: 'dismiss', filed: null, text: 'Dismissed: Radio cannot be unticked.' },
  ] as const)('$outcome', ({ outcome, filed, text }) => {
    expect(settledText(proposal({ outcome, filed_task: filed }))).toBe(text)
  })
})

describe('settleProblem', () => {
  const conflict = (details: Record<string, unknown>) => new ApiError(409, 'conflict', 'x', details)
  it.each([
    {
      name: 'settled',
      error: conflict({ reason: 'settled' }),
      text: 'This proposal was settled meanwhile; its latest state is shown.',
    },
    {
      name: 'duplicate',
      error: conflict({ reason: 'duplicate', key: 'AIDP-9', state: 'done' }),
      text: 'AIDP-9 (done) already has this title. Dismiss the proposal, or file the task by hand under another title.',
    },
    {
      name: 'not offered',
      error: conflict({ reason: 'not_offered' }),
      text: 'That did not work. Try again.',
    },
    {
      name: 'a server error',
      error: new ApiError(500, 'internal_error', 'x'),
      text: 'That did not work. Try again.',
    },
    { name: 'a network error', error: new Error('offline'), text: 'That did not work. Try again.' },
  ])('$name', ({ error, text }) => expect(settleProblem(error)).toBe(text))
})

describe('arrivals', () => {
  it('announces nothing on the first load, and then only new proposals', () => {
    const a = proposal({ id: 'a' })
    const b = proposal({ id: 'b', title: 'Second' })
    expect(arrivals(undefined, [a])).toEqual([])
    expect(arrivals(new Set(['a']), [a, b])).toEqual([b])
    expect(arrivals(new Set(['a', 'b']), [a, b])).toEqual([])
  })
})

describe('the proposal help', () => {
  const help = (overrides: Partial<HelpView>): HelpView => ({
    id: 'h',
    approval_id: null,
    decision: 'proposal',
    subject: { proposal_id: 'p1' },
    question_index: null,
    mode: 'check',
    status: 'queued',
    result: null,
    reason: null,
    created_at: '2026-11-12T10:00:00Z',
    ...overrides,
  })
  it('is busy while queued, shows the latest result, and names a failure', () => {
    expect(proposalHelp([help({})], 'p1').busy).toBe(true)
    expect(proposalHelp([help({})], 'other').busy).toBe(false)
    const result = {
      mode: 'advise' as const,
      variant: 'file' as const,
      reasoning: 'r',
      unsure: 'u',
    }
    expect(proposalHelp([help({ status: 'succeeded', result })], 'p1').result).toEqual(result)
    expect(proposalHelp([help({ status: 'failed', reason: 'boom' })], 'p1').failure).toBe('boom')
  })
  it('is announced when it ends, and not when it was stopped', () => {
    expect(proposalHelpAnnouncement(help({ status: 'succeeded' }), 'T')).toBe(
      'Suggested settlement ready for "T".',
    )
    expect(proposalHelpAnnouncement(help({ status: 'failed', reason: 'boom' }), 'T')).toBe(
      'No suggested settlement for "T": boom.',
    )
    expect(proposalHelpAnnouncement(help({ status: 'stopped' }), 'T')).toBeNull()
  })
})
