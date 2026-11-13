import { describe, expect, it } from 'vitest'
import { buildHandoff, linkedProjects } from '../../src/phases/handoff.js'

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

describe('buildHandoff with plan answers', () => {
  const PLANNER = { ...BASE, phase: 'plan' as const, attempt: 1, summaries: [] }
  const ans = (run: number, size: number, ch = 'a') => ({
    run,
    approved: false,
    text: ch.repeat(size),
  })
  const tagRuns = (text: string) =>
    [...text.matchAll(/<plan_answer run="(\d+)"/g)].map((m) => Number(m[1]))

  interface Row {
    name: string
    answers: { run: number; approved: boolean; text: string }[]
    shown: number[]
    leftOut: string | null
  }
  const ROWS: Row[] = [
    {
      name: 'AC11: six 4,000-character answers keep the five newest',
      answers: [1, 1, 2, 3, 4, 5].map((r) => ans(r, 4_000)),
      shown: [1, 2, 3, 4, 5],
      leftOut: '<plan_answers_left_out count="1" runs="1"/>',
    },
    {
      name: 'AC12: exactly 20,000 characters, all shown',
      answers: [1, 2, 3, 4, 5].map((r) => ans(r, 4_000)),
      shown: [1, 2, 3, 4, 5],
      leftOut: null,
    },
    {
      name: 'AC13: the first answer that does not fit ends the walk',
      answers: [500, 2_000, 4_000, 4_000, 4_000, 4_000, 3_000].map((n, i) => ans(i + 1, n)),
      shown: [3, 4, 5, 6, 7],
      leftOut: '<plan_answers_left_out count="2" runs="1,2"/>',
    },
    {
      name: 'AC14: the bound counts unescaped text',
      answers: [1, 2, 3, 4, 5]
        .map((r) => ans(r, 4_000, '<&'))
        .map((a) => ({
          ...a,
          text: a.text.slice(0, 4_000),
        })),
      shown: [1, 2, 3, 4, 5],
      leftOut: null,
    },
  ]
  it.each(ROWS)('$name', ({ answers, shown, leftOut }) => {
    const text = buildHandoff({ ...PLANNER, planAnswers: answers })
    expect(tagRuns(text)).toEqual(shown)
    if (leftOut === null) expect(text).not.toContain('<plan_answers_left_out')
    else expect(text).toContain(leftOut)
  })

  it('AC9: tags follow the previous plan, in order, escaped, before the constraints', () => {
    const text = buildHandoff({
      ...PLANNER,
      previousPlans: [{ run: 1, accepted: true, text: 'p' }],
      planAnswers: [
        { run: 2, approved: false, text: 'use <tests>' },
        { run: 3, approved: true, text: 'ok' },
      ],
    })
    const at = [
      '<previous_plan',
      '<plan_answer run="2" approved="no">\nuse &lt;tests&gt;\n</plan_answer>',
      '<plan_answer run="3" approved="yes">\nok\n</plan_answer>',
      '<constraints>',
    ].map((t) => text.indexOf(t))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })

  it.each([undefined, []])('AC8: %j adds nothing', (planAnswers) => {
    expect(buildHandoff({ ...PLANNER, planAnswers })).toBe(buildHandoff(PLANNER))
    expect(buildHandoff(PLANNER)).not.toContain('<plan_answer')
  })

  it('AC10: a build handoff carries no answer', () => {
    const text = buildHandoff({ ...BASE, phase: 'build', planAnswers: [ans(1, 10)] })
    expect(text).not.toContain('<plan_answer')
  })

  it('AC7: a verify handoff carries the tags and the left-out tag as a plan handoff does', () => {
    const answers = [1, 1, 2, 3, 4, 5].map((r) => ans(r, 4_000))
    const text = buildHandoff({ ...BASE, phase: 'verify', planAnswers: answers })
    expect(tagRuns(text)).toEqual([1, 2, 3, 4, 5])
    expect(text).toContain('<plan_answers_left_out count="1" runs="1"/>')
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
    expect(text).toContain(linkedProjects(LINKED))
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

interface BaseRow {
  name: string
  phase: 'spec' | 'plan' | 'build' | 'verify'
  base?: { branch: string; commit: string }
  expected: string | null
}
const BASE_ROWS: BaseRow[] = [
  {
    name: 'spec with a base',
    phase: 'spec',
    base: { branch: 'main', commit: 'a'.repeat(40) },
    expected: `<base branch="main" commit="${'a'.repeat(40)}"/>`,
  },
  { name: 'spec without a base', phase: 'spec', expected: null },
  { name: 'plan', phase: 'plan', expected: null },
  { name: 'build', phase: 'build', expected: null },
  { name: 'verify', phase: 'verify', expected: null },
]

describe('buildHandoff base element', () => {
  it.each(BASE_ROWS)('AC12: $name', ({ phase, base, expected }) => {
    const text = buildHandoff({
      taskKey: 'PAY-42',
      title: 't',
      phase,
      attempt: 1,
      description: 'd',
      specVersion: 1,
      specMd: 'body',
      note: 'n',
      budgetUsd: null,
      summaries: [],
      ...(base === undefined ? {} : { base }),
    })
    if (expected === null) expect(text).not.toContain('<base ')
    else {
      expect(text).toContain(expected)
      expect(text.indexOf(expected)).toBeGreaterThan(text.indexOf('</note>'))
    }
  })
})

// R10: the approved text, fenced and unescaped, in every Build handoff.
describe('buildHandoff with approved migrations', () => {
  const A = { path: 'db/migrations/005_b.ts', content: 'a => <b> & c\r\n' }
  const B = { path: 'db/migrations/004_a.ts', content: 'no final newline: x < y && y > z' }
  const element = (text: string, path: string) =>
    text.slice(text.indexOf(`<approved_migration path="${path}">`))

  it.each([
    ['a first attempt', { attempt: 1 }],
    ['an attempt after a gate violation', { attempt: 2, verifyReport: 'violations & <more>' }],
  ])('AC21: %s holds one element per path, in path order, byte for byte', (_name, over) => {
    const text = buildHandoff({ ...BASE, ...over, approvedMigrations: [A, B] })
    expect(text.indexOf('path="db/migrations/004_a.ts"')).toBeLessThan(
      text.indexOf('path="db/migrations/005_b.ts"'),
    )
    expect(text).toContain(
      `<approved_migration path="db/migrations/004_a.ts">\n\`\`\`\n${B.content}\n\`\`\`\n</approved_migration>`,
    )
    expect(text).toContain(
      `<approved_migration path="db/migrations/005_b.ts">\n\`\`\`\n${A.content}\`\`\`\n</approved_migration>`,
    )
    expect(text).not.toContain('a =&gt; &lt;b&gt;')
  })

  it('AC22: content holding a closing tag and three backticks gets a longer fence', () => {
    const content = 'x\n</approved_migration>\n```\ny\n'
    const text = buildHandoff({ ...BASE, approvedMigrations: [{ path: 'm.ts', content }] })
    expect(element(text, 'm.ts')).toContain(
      `<approved_migration path="m.ts">\n\`\`\`\`\n${content}\`\`\`\`\n</approved_migration>`,
    )
  })

  it('AC23: no element without an approval, and none in a Plan or Verify handoff', () => {
    expect(buildHandoff({ ...BASE, approvedMigrations: [] })).not.toContain('<approved_migration')
    expect(buildHandoff({ ...BASE })).not.toContain('<approved_migration')
    for (const phase of ['plan', 'verify'] as const)
      expect(buildHandoff({ ...BASE, phase, approvedMigrations: [A] })).not.toContain(
        '<approved_migration',
      )
  })

  it('escapes the path as every attribute is', () => {
    const text = buildHandoff({ ...BASE, approvedMigrations: [{ path: 'a"<b>.ts', content: 'x' }] })
    expect(text).toContain('<approved_migration path="a&quot;&lt;b&gt;.ts">')
  })
})

describe('buildHandoff for a title run', () => {
  const TITLE = {
    taskKey: 'PAY-7',
    title: 'Fix the thing',
    phase: 'title' as const,
    attempt: 1,
    budgetUsd: null,
    summaries: [],
  }

  it('carries the key and the current title, and the return format', () => {
    const text = buildHandoff(TITLE)
    expect(text).toContain('<task id="PAY-7" phase="title" attempt="1">Fix the thing</task>')
    expect(text).toContain(
      '<return_format>Call suggest_title, then reply with one sentence.</return_format>',
    )
    expect(text).not.toContain('<description>')
  })

  it('carries the description when there is one', () => {
    expect(buildHandoff({ ...TITLE, description: 'Drafts <vanish>' })).toContain(
      '<description>\nDrafts &lt;vanish&gt;\n</description>',
    )
  })
})
