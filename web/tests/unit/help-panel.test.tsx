import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { HelpButtons, HelpResults, type PanelMode, type Renderers } from '../../src/card/HelpPanel'
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
