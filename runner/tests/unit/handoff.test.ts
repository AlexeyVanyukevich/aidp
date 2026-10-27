import { describe, expect, it } from 'vitest'
import { buildHandoff } from '../../src/phases/handoff.js'

const BASE = {
  taskKey: 'PAY-42',
  title: 'Retry <webhooks> & more',
  phase: 'build' as const,
  attempt: 2,
  specVersion: 3,
  specMd: '## Requirements\n1. R1 – x',
  budgetUsd: 3,
  summaries: [{ phase: 'plan', attempt: 1, text: 'Planned two steps' }],
}

describe('buildHandoff', () => {
  it('follows the platform design’s handoff contract, escaping text', () => {
    const text = buildHandoff({ ...BASE, plan: '1. Backoff', verifyReport: '| AC1 | ✘ fail |' })
    expect(text).toContain(
      '<task id="PAY-42" phase="build" attempt="2">Retry &lt;webhooks&gt; &amp; more</task>',
    )
    expect(text).toContain('<spec version="3">')
    expect(text).toContain('<summary phase="plan" attempt="1">Planned two steps</summary>')
    expect(text).toContain('<verify_report>')
    expect(text).toContain('<budget usd="3.00"/>')
    expect(text).toContain('<return_format>')
  })

  it('cuts a huge diff to its first 60,000 characters and says so', () => {
    const text = buildHandoff({ ...BASE, phase: 'verify', diff: 'd'.repeat(100_000) })
    expect(text).toContain('[diff cut: 40000 more characters]')
  })

  it('omits sections it was not given', () => {
    const text = buildHandoff({
      ...BASE,
      phase: 'plan',
      attempt: 1,
      summaries: [],
      budgetUsd: null,
    })
    expect(text).not.toContain('<diff>')
    expect(text).not.toContain('<budget')
  })
})

// Slice 3 spec §5: a draft starts from the task's description, and a redraft from a version
// and the owner's note.
describe('buildHandoff for the spec phase', () => {
  const DRAFT = {
    taskKey: 'PAY-42',
    title: 'Retry webhooks',
    phase: 'spec' as const,
    attempt: 1,
    description: 'Retry <failed> webhooks & log them',
    budgetUsd: null,
    summaries: [],
  }

  it('gives a first draft the description and the return format, and no spec', () => {
    const text = buildHandoff(DRAFT)
    expect(text).toContain('<task id="PAY-42" phase="spec" attempt="1">Retry webhooks</task>')
    expect(text).toContain(
      '<description>\nRetry &lt;failed&gt; webhooks &amp; log them\n</description>',
    )
    expect(text).not.toContain('<spec')
    expect(text).not.toContain('<note>')
    expect(text).toContain(
      '<return_format>Call save_spec until the lint is clean, then reply with one paragraph.</return_format>',
    )
  })

  it('gives a redraft the version it redrafts and the owner’s note', () => {
    const text = buildHandoff({
      ...DRAFT,
      specVersion: 2,
      specMd: '## Requirements\n1. R1 – x',
      note: 'Say <how> long',
    })
    expect(text).toContain('<spec version="2">\n## Requirements\n1. R1 – x\n</spec>')
    expect(text).toContain('<note>\nSay &lt;how&gt; long\n</note>')
  })
})

// AIDP-25: a planner starting again is shown the plans of earlier runs, apart from <plan>.
describe('buildHandoff with previous plans', () => {
  const PLANNER = { ...BASE, phase: 'plan' as const, attempt: 1, summaries: [] }
  interface Row {
    name: string
    previous: { run: number; accepted: boolean; text: string }[] | undefined
    tags: string[]
  }
  const ROWS: Row[] = [
    {
      name: 'AC9: one accepted plan',
      previous: [{ run: 1, accepted: true, text: 'plan <one>' }],
      tags: ['<previous_plan run="1" accepted="yes">\nplan &lt;one&gt;\n</previous_plan>'],
    },
    {
      name: 'AC10: an unaccepted newest and an accepted older one, in that order',
      previous: [
        { run: 2, accepted: false, text: 'two' },
        { run: 1, accepted: true, text: 'one' },
      ],
      tags: [
        '<previous_plan run="2" accepted="no">\ntwo\n</previous_plan>',
        '<previous_plan run="1" accepted="yes">\none\n</previous_plan>',
      ],
    },
  ]
  it.each(ROWS)('$name', ({ previous, tags }) => {
    const text = buildHandoff({ ...PLANNER, previousPlans: previous })
    for (const tag of tags) expect(text).toContain(tag)
    expect(text.indexOf(tags[0] ?? '')).toBeLessThan(text.indexOf('<constraints>'))
    expect(text).not.toContain('<plan>')
  })

  it.each([undefined, []])('AC11: %j adds nothing', (previous) => {
    const without = buildHandoff(PLANNER)
    expect(buildHandoff({ ...PLANNER, previousPlans: previous })).toBe(without)
    expect(without).not.toContain('previous_plan')
  })

  it('cuts a plan at 20,000 characters', () => {
    const text = buildHandoff({
      ...PLANNER,
      previousPlans: [{ run: 1, accepted: true, text: 'p'.repeat(25_000) }],
    })
    expect(text).toContain('[previous plan cut: 5000 more characters]')
  })
})

// A run's linked projects: read-only checkouts, listed for every phase.
describe('buildHandoff with linked projects', () => {
  const LINKED = [
    {
      key: 'ZLC',
      name: 'Zellige <kit>',
      github_repo: 'owner/zellige',
      base_branch: 'main',
      path: '/home/worktrees/run-linked/ZLC',
      note: 'the kit, for <Button> & co',
    },
    {
      key: 'ABC',
      name: 'Alpha',
      github_repo: 'owner/alpha',
      base_branch: 'trunk',
      path: '/home/worktrees/run-linked/ABC',
      note: 'first',
    },
  ]
  const PHASES = ['spec', 'plan', 'build', 'verify'] as const

  it.each(PHASES)('AC18: lists the checkouts by key in the %s handoff, escaped', (phase) => {
    const text = buildHandoff({ ...BASE, phase, linked: LINKED })
    expect(text).toContain(
      '<project key="ZLC" name="Zellige &lt;kit&gt;" github_repo="owner/zellige" base_branch="main" path="/home/worktrees/run-linked/ZLC">the kit, for &lt;Button&gt; &amp; co</project>',
    )
    expect(text.indexOf('<project key="ABC"')).toBeLessThan(text.indexOf('<project key="ZLC"'))
    expect(text).toContain('<linked_projects>')
    expect(text).toContain('may be read and never changed')
  })

  it.each(PHASES)('AC18: is unchanged from before in the %s handoff without links', (phase) => {
    const without = buildHandoff({ ...BASE, phase })
    expect(buildHandoff({ ...BASE, phase, linked: [] })).toBe(without)
    expect(without).not.toContain('linked_projects')
    expect(without).toContain(
      '<constraints>Work only inside this worktree. Never push. Stop and say so in your reply if the spec cannot be met as written.</constraints>',
    )
  })
})
