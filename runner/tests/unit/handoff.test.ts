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
