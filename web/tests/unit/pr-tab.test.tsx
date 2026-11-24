import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PrTab } from '../../src/card/PrTab'
import { SendBack, sendBackHint, SEND_BACK_BLANK } from '../../src/card/SendBack'
import { sendBackShown } from '../../src/card/blocks'
import type { PrReviewResult } from '../../src/card/approvals'
import type { TaskView } from '../../src/types'

// The kit's published build cannot load in Node here; the section uses these few parts.
vi.mock('@zellige/react', () => ({
  Field: ({
    label,
    hint,
    error,
    children,
  }: {
    label: string
    hint?: string
    error?: string
    children?: unknown
  }) => (
    <div data-field>
      <label>{label}</label>
      {hint !== undefined && <p data-hint>{hint}</p>}
      {error !== undefined && <p data-error>{error}</p>}
      {children as string}
    </div>
  ),
  Textarea: ({ value }: { value: string }) => <textarea defaultValue={value} />,
  Button: ({ children, busy }: { children?: unknown; busy?: boolean }) => (
    <button aria-busy={busy === true ? 'true' : 'false'}>{children as string}</button>
  ),
  RadioGroup: ({ label, children }: { label: string; children?: unknown }) => (
    <div role="radiogroup" aria-label={label}>
      {children as string}
    </div>
  ),
  Loading: () => <p>Loading</p>,
  Badge: ({ children }: { children?: unknown }) => <span>{children as string}</span>,
  Empty: ({ title }: { title: string }) => <p>{title}</p>,
  Radio: ({ children }: { children?: unknown }) => <label>{children as string}</label>,
}))

const REVIEW: { result: PrReviewResult; createdAt: string } = {
  createdAt: '2026-11-20T10:30:00Z',
  result: {
    mode: 'code_review',
    verdict: 'changes',
    blockers: 1,
    findings: [
      {
        kind: 'bug',
        where: 'a.ts:1',
        text: 'Off by one',
        matters: 'm',
        destination: 'blocker',
        evidence: 'a.ts:1',
      },
    ],
    next_step: 'fix_by_hand',
    reasoning: 'r',
    unsure: 'u',
    commit: 'abcdef0123456789',
    skipped: [],
  } as unknown as PrReviewResult,
}

const html = (review?: typeof REVIEW) =>
  renderToStaticMarkup(
    <SendBack branch="board/PAY-1-r1" review={review} busy={false} onSend={() => undefined} />,
  )

describe('the Send back with changes section', () => {
  it('holds an h3, the field named Changes to make with its hint, and the button', () => {
    const out = html()
    expect(out).toMatch(/<h3[^>]*>Send back with changes<\/h3>/)
    expect(out).toContain('<label>Changes to make</label>')
    const hint =
      'A builder makes these on board/PAY-1-r1; Verify runs again before the card returns to Review.'
    expect(sendBackHint('board/PAY-1-r1')).toBe(hint)
    expect(out).toContain(`<p data-hint="true">${hint}</p>`)
    expect(out).toMatch(/<button[^>]*>Send back<\/button>/)
    expect(out).not.toContain('<h4')
  })

  it('offers Use the pull request review only when a review exists', () => {
    expect(html()).not.toContain('Use the pull request review')
    expect(html(REVIEW)).toContain('Use the pull request review')
  })

  it('names the error a blank field gets', () => {
    expect(SEND_BACK_BLANK).toBe('Say what to change.')
  })
})

describe('where the section shows', () => {
  const rows: [TaskView['state'], boolean, boolean][] = [
    ['review', true, true],
    ['review', false, false],
    ['done', true, false],
    ['failed', true, false],
    ['running', true, false],
    ['ready', true, false],
  ]
  it.each(rows)('state %s, pull request %s: shown %s', (state, hasPr, shown) => {
    expect(sendBackShown(state, hasPr)).toBe(shown)
  })
})

describe('the PR tab of a card back in Review after a failed continuing run (AC16)', () => {
  it('shows the link, the branch, the failure reason, Review pull request and Send back', () => {
    const client = new QueryClient()
    const run = {
      id: 'r2',
      number: 2,
      kind: 'delivery',
      status: 'failed',
      branch: 'board/PAY-1-r1',
      pr_number: 7,
      pr_url: 'https://github.com/o/p/pull/7',
      failure_reason: 'the build made no commit on attempt 3',
      phases: [],
      artifacts: [],
    }
    client.setQueryData(['runs', 't1'], [run])
    client.setQueryData(['helps', 't1'], [])
    client.setQueryData(['pr-files', 'r2'], { files: [] })
    const task = {
      id: 't1',
      key: 'PAY-1',
      state: 'review',
      has_pull_request: true,
      block: null,
    } as unknown as TaskView
    const out = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PrTab
          task={task}
          onProblem={() => undefined}
          onAnnounce={() => undefined}
          onMoved={() => undefined}
        />
      </QueryClientProvider>,
    )
    expect(out).toContain('href="https://github.com/o/p/pull/7"')
    expect(out).toContain('board/PAY-1-r1')
    expect(out).toContain('The last run did not finish: the build made no commit on attempt 3')
    expect(out).toContain('Review pull request')
    expect(out).toMatch(/<h3[^>]*>Send back with changes<\/h3>/)
  })
})
