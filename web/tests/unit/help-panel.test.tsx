import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  decisionRenderers,
  HelpButtons,
  HelpResults,
  type PanelMode,
  type Renderers,
} from '../../src/card/HelpPanel'
import {
  decisionAnnouncement,
  decisionHelp,
  goneResults,
  NO_HELP,
  resultHeading,
} from '../../src/card/approvals'
import type { HelpMode, HelpResult, HelpView } from '../../src/types'

// The kit's published build cannot load in Node here; the panel uses only Button.
vi.mock('@zellige/react', () => ({
  Badge: ({ tone, children }: { tone?: string; children?: unknown }) => (
    <span data-tone={tone}>{children as string}</span>
  ),
  Button: ({
    busy,
    children,
    onClick: _onClick,
  }: {
    busy?: boolean
    children?: unknown
    onClick?: () => void
  }) => <button aria-busy={busy === true ? 'true' : 'false'}>{children as string}</button>,
}))

const RESULTS: Record<HelpMode, HelpResult> = {
  suggest: { mode: 'suggest', reasoning: 'r', unsure: 'u', text: 't' },
  explain: { mode: 'explain', asked: 'a', matters: 'm', leads_to: 'l' },
  review: { mode: 'review', verdict: 'nothing_to_change', findings: [], unsure: 'u' },
  restate: { mode: 'restate', changes: 'c', requirements: 'r', left_out: 'l' },
  recommend: {
    mode: 'recommend',
    why_stopped: 'w',
    action: 'cancel',
    reasoning: 'r',
    unsure: 'u',
  },
  check: {
    mode: 'check',
    checked_against: 'description',
    produced: 'p',
    unfinished: [],
    unsure: 'u',
  },
  code_review: {
    mode: 'code_review',
    verdict: 'changes',
    findings: [
      { kind: 'bug', where: 'server/src/a.ts:12', text: 'Off by one', matters: 'Loses a row' },
    ],
    unsure: 'u',
    commit: 'abcdef0123456789',
    skipped: [],
  },
}

interface Row {
  mode: HelpMode
  label: string
  busy: boolean
  shown: boolean
  failure?: string
  level: 3 | 4 | 5
  heading: string
}
const rows: Row[] = [
  {
    mode: 'suggest',
    label: 'Suggest an answer',
    busy: false,
    shown: true,
    level: 4,
    heading: 'Suggested answer',
  },
  {
    mode: 'explain',
    label: 'Explain simply',
    busy: true,
    shown: false,
    level: 5,
    heading: 'In plain words',
  },
  {
    mode: 'review',
    label: 'Review spec',
    busy: false,
    shown: true,
    level: 4,
    heading: 'Spec review of v3',
  },
  {
    mode: 'restate',
    label: 'Explain simply',
    busy: false,
    shown: false,
    failure: 'no budget',
    level: 4,
    heading: 'v3 in plain words',
  },
  {
    mode: 'recommend',
    label: 'Suggest what to do',
    busy: true,
    shown: false,
    level: 3,
    heading: 'Suggested next step',
  },
  {
    mode: 'check',
    label: 'Check what is unfinished',
    busy: false,
    shown: true,
    level: 3,
    heading: 'What is unfinished',
  },
  {
    mode: 'code_review',
    label: 'Review pull request',
    busy: true,
    shown: false,
    failure: 'no budget',
    level: 3,
    heading: 'Pull request review of abcdef0',
  },
]

const modeOf = (row: Row): PanelMode => ({
  id: row.mode,
  label: row.label,
  heading: row.heading,
  failureLine: (reason) => `Failed ${row.mode}: ${reason}`,
  state: {
    busy: row.busy,
    shown: row.shown ? RESULTS[row.mode] : undefined,
    failure: row.failure,
  },
})
const renderers: Renderers = Object.fromEntries(
  Object.keys(RESULTS).map((mode) => [mode, () => <p>body of {mode}</p>]),
)

describe('HelpButtons and HelpResults (AC27)', () => {
  it.each(rows)('renders $mode', (row) => {
    const buttons = renderToStaticMarkup(
      <HelpButtons modes={[modeOf(row)]} onAsk={() => undefined} />,
    )
    expect(buttons).toContain(`aria-busy="${row.busy}"`)
    expect(buttons).toContain(`>${row.label}</button>`)
    const results = renderToStaticMarkup(
      <HelpResults modes={[modeOf(row)]} renderers={renderers} level={row.level} />,
    )
    if (row.shown) {
      expect(results).toMatch(new RegExp(`<h${row.level}[^>]*>${row.heading}</h${row.level}>`))
      expect(results).toContain(`body of ${row.mode}`)
    } else expect(results).not.toContain(row.heading)
    if (row.failure !== undefined) expect(results).toContain(`Failed ${row.mode}: ${row.failure}`)
  })
})

const help = (change: Partial<HelpView>): HelpView => ({
  id: 'h1',
  approval_id: null,
  decision: 'spec_review',
  subject: { spec_version: 3 },
  question_index: null,
  mode: 'review',
  status: 'succeeded',
  result: RESULTS.review,
  reason: null,
  created_at: '2026-10-20T10:00:00Z',
  ...change,
})

describe('decisionHelp', () => {
  const table: {
    name: string
    helps: HelpView[]
    decision: 'spec_review' | 'stopped_run' | 'mark_done'
    mode: HelpMode
    busy: boolean
    shown: boolean
    failure?: string
  }[] = [
    {
      name: 'nothing asked',
      helps: [],
      decision: 'spec_review',
      mode: 'review',
      busy: false,
      shown: false,
    },
    {
      name: 'a succeeded review',
      helps: [help({})],
      decision: 'spec_review',
      mode: 'review',
      busy: false,
      shown: true,
    },
    {
      name: 'a running review keeps the older result',
      helps: [
        help({ id: 'h2', status: 'running', result: null, created_at: '2026-10-20T10:05:00Z' }),
        help({}),
      ],
      decision: 'spec_review',
      mode: 'review',
      busy: true,
      shown: true,
    },
    {
      name: 'a failed review gives its reason',
      helps: [help({ status: 'failed', result: null, reason: 'no budget' })],
      decision: 'spec_review',
      mode: 'review',
      busy: false,
      shown: false,
      failure: 'no budget',
    },
    {
      name: 'another mode is its own',
      helps: [help({})],
      decision: 'spec_review',
      mode: 'restate',
      busy: false,
      shown: false,
    },
    {
      name: 'another decision is its own',
      helps: [help({})],
      decision: 'mark_done',
      mode: 'check',
      busy: false,
      shown: false,
    },
  ]
  it.each(table)('$name', ({ helps, decision, mode, busy, shown, failure }) => {
    const state = decisionHelp(helps, decision)[mode] ?? NO_HELP
    expect({ busy: state.busy, shown: state.shown !== undefined, failure: state.failure }).toEqual({
      busy,
      shown,
      failure,
    })
  })
})

describe('decision announcements (AC31)', () => {
  const table: { name: string; help: HelpView; text: string | null }[] = [
    { name: 'a review', help: help({}), text: 'Spec review ready for v3.' },
    {
      name: 'a failed review',
      help: help({ status: 'failed', reason: 'x' }),
      text: 'No spec review for v3: x.',
    },
    {
      name: 'a restatement',
      help: help({ mode: 'restate' }),
      text: 'Plain-words spec ready for v3.',
    },
    {
      name: 'a failed restatement',
      help: help({ mode: 'restate', status: 'failed', reason: 'x' }),
      text: 'No plain-words spec for v3: x.',
    },
    {
      name: 'a recommendation',
      help: help({ decision: 'stopped_run', mode: 'recommend' }),
      text: 'Suggested next step ready for the stopped run.',
    },
    {
      name: 'a failed recommendation',
      help: help({ decision: 'stopped_run', mode: 'recommend', status: 'failed', reason: 'x' }),
      text: 'No suggested next step for the stopped run: x.',
    },
    {
      name: 'a check',
      help: help({ decision: 'mark_done', mode: 'check' }),
      text: 'Unfinished-work check ready for Mark done.',
    },
    {
      name: 'a failed check',
      help: help({ decision: 'mark_done', mode: 'check', status: 'failed', reason: 'x' }),
      text: 'No unfinished-work check for Mark done: x.',
    },
    { name: 'a stopped help', help: help({ status: 'stopped' }), text: null },
    {
      name: 'a pull request review',
      help: help({
        decision: 'pull_request',
        mode: 'code_review',
        subject: { pr_run_id: 'r' },
        result: RESULTS.code_review,
      }),
      text: 'Pull request review ready for abcdef0.',
    },
    {
      name: 'a pull request review with no commit',
      help: help({
        decision: 'pull_request',
        mode: 'code_review',
        result: { ...RESULTS.code_review, commit: null } as HelpResult,
      }),
      text: 'Pull request review ready.',
    },
    {
      name: 'a failed pull request review',
      help: help({
        decision: 'pull_request',
        mode: 'code_review',
        status: 'failed',
        result: null,
        reason: 'the branch is gone',
      }),
      text: 'No pull request review: the branch is gone.',
    },
    {
      name: 'a stopped pull request review',
      help: help({ decision: 'pull_request', mode: 'code_review', status: 'stopped' }),
      text: null,
    },
  ]
  it.each(table)('says $name', ({ help: h, text }) => {
    expect(decisionAnnouncement(h)).toBe(text)
  })
  it('heads a result with its version', () => {
    expect(resultHeading('review', { spec_version: 4 })).toBe('Spec review of v4')
  })
})

describe('goneResults (AC42)', () => {
  const table: {
    name: string
    before: HelpView[]
    after: HelpView[]
    changed: boolean
    text: string[]
  }[] = [
    {
      name: 'a review that goes away with the state unchanged',
      before: [help({})],
      after: [],
      changed: false,
      text: ['Spec review of v3 no longer applies.'],
    },
    {
      name: 'a failure line that goes away',
      before: [help({ status: 'failed', mode: 'restate' })],
      after: [],
      changed: false,
      text: ['v3 in plain words no longer applies.'],
    },
    { name: 'the state changed', before: [help({})], after: [], changed: true, text: [] },
    {
      name: 'a help that is still listed',
      before: [help({})],
      after: [help({})],
      changed: false,
      text: [],
    },
    {
      name: 'a help stopped before it showed',
      before: [help({ status: 'running', result: null })],
      after: [],
      changed: false,
      text: [],
    },
  ]
  it.each(table)('$name', ({ before, after, changed, text }) => {
    expect(goneResults(before, after, changed)).toEqual(text)
  })
})

describe('decisionRenderers and Use these findings', () => {
  const changes: HelpResult = {
    mode: 'review',
    verdict: 'changes',
    findings: [{ kind: 'missing', where: 'R1', text: 'No retry limit' }],
    unsure: 'u',
  }
  const render = (result: HelpResult, handler: boolean) => {
    const renderers = decisionRenderers(1, handler ? () => undefined : undefined)
    const node =
      result.mode === 'review'
        ? renderers.review?.(result)
        : result.mode === 'restate'
          ? renderers.restate?.(result)
          : result.mode === 'recommend'
            ? renderers.recommend?.(result)
            : result.mode === 'check'
              ? renderers.check?.(result)
              : result.mode === 'code_review'
                ? renderers.code_review?.(result)
                : null
    return renderToStaticMarkup(<>{node}</>)
  }
  const table: { name: string; result: HelpResult; handler: boolean; button: boolean }[] = [
    { name: 'changes, with the handler', result: changes, handler: true, button: true },
    { name: 'changes, without it', result: changes, handler: false, button: false },
    ...(['with', 'without'] as const).flatMap((w) => [
      {
        name: `nothing to change, ${w} the handler`,
        result: RESULTS.review,
        handler: w === 'with',
        button: false,
      },
      {
        name: `restate, ${w} the handler`,
        result: RESULTS.restate,
        handler: w === 'with',
        button: false,
      },
      {
        name: `recommend, ${w} the handler`,
        result: RESULTS.recommend,
        handler: w === 'with',
        button: false,
      },
      {
        name: `check, ${w} the handler`,
        result: RESULTS.check,
        handler: w === 'with',
        button: false,
      },
    ]),
  ]
  it.each(table)('$name', ({ result, handler, button }) => {
    const markup = render(result, handler)
    expect(markup.includes('<button')).toBe(button)
    if (button) {
      expect(markup).toContain('Use these findings')
      expect(markup.indexOf('Unsure about')).toBeLessThan(markup.indexOf('Use these findings'))
    }
  })
})

describe('the pull request review result', () => {
  const markup = (result: HelpResult) => {
    const node = decisionRenderers(null).code_review?.(result as never)
    return renderToStaticMarkup(<>{node}</>)
  }
  it('shows each finding with a neutral kind badge, where, text and why it matters', () => {
    const html = markup(RESULTS.code_review)
    expect(html).toContain('<span data-tone="neutral">bug</span>')
    expect(html).toContain('server/src/a.ts:12')
    expect(html).toContain('Off by one')
    expect(html).toContain('<strong>Why it matters:</strong> Loses a row')
    expect(html.indexOf('Why it matters:')).toBeLessThan(html.indexOf('Unsure about'))
  })
  it('says Nothing to change. and holds no focusable control', () => {
    const html = markup({
      mode: 'code_review',
      verdict: 'nothing_to_change',
      findings: [],
      unsure: 'u',
      commit: null,
      skipped: [],
    })
    expect(html).toContain('Nothing to change.')
    for (const html2 of [html, markup(RESULTS.code_review)]) {
      expect(html2).not.toMatch(/<(button|a|input|select|textarea)\b/)
    }
  })
  const skippedRows: {
    name: string
    skipped: { path: string; skip: string }[]
    shown: string[]
  }[] = [
    { name: 'none skipped', skipped: [], shown: [] },
    {
      name: 'a lockfile and a generated file',
      skipped: [
        { path: 'package-lock.json', skip: 'lockfile' },
        { path: 'dist/app.min.js', skip: 'generated' },
      ],
      shown: [
        '<strong>Not reviewed:</strong> <code>package-lock.json</code> (lockfile), <code>dist/app.min.js</code> (generated)',
      ],
    },
  ]
  it.each(skippedRows)('lists the files the board skipped: $name', ({ skipped, shown }) => {
    const html = markup({ ...RESULTS.code_review, skipped } as HelpResult)
    if (shown.length === 0) expect(html).not.toContain('Not reviewed')
    for (const text of shown) expect(html).toContain(text)
    if (shown.length > 0)
      expect(html.indexOf('Not reviewed')).toBeLessThan(html.indexOf('Unsure about'))
  })
  it('heads the result with the short commit, or plainly without one', () => {
    expect(resultHeading('code_review', null, RESULTS.code_review)).toBe(
      'Pull request review of abcdef0',
    )
    expect(resultHeading('code_review', null)).toBe('Pull request review')
  })
  it('lists the review beside a decision of its own in decisionHelp', () => {
    const review = help({
      decision: 'pull_request',
      mode: 'code_review',
      result: RESULTS.code_review,
    })
    const state = decisionHelp([review], 'pull_request').code_review
    expect(state?.shown).toEqual(RESULTS.code_review)
    expect(decisionHelp([review], 'mark_done').code_review?.shown).toBeUndefined()
  })
})
