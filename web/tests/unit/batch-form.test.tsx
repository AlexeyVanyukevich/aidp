import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BatchForm } from '../../src/card/BatchForm'
import type { BatchQuestion, HelpView } from '../../src/types'

// The kit's published build cannot load in Node here; the form uses these widgets.
vi.mock('@zellige/react', () => ({
  Badge: ({ children }: { children?: unknown }) => <span>{children as string}</span>,
  Markdown: ({ source }: { source: string }) => <div>{source}</div>,
  Field: ({ label, children }: { label: string; children?: unknown }) => (
    <label>
      {label}
      {children as string}
    </label>
  ),
  Textarea: () => <textarea />,
  RadioGroup: ({ label, children }: { label: string; children?: unknown }) => (
    <div role="radiogroup" aria-label={label}>
      {children as string}
    </div>
  ),
  Radio: ({ value, children }: { value: string; children?: unknown }) => (
    <label>
      <input type="radio" value={value} />
      {children as string}
    </label>
  ),
  Button: ({
    busy,
    children,
    type,
    disabled,
  }: {
    busy?: boolean
    children?: unknown
    type?: string
    disabled?: boolean
  }) => (
    <button
      type={(type ?? 'button') as 'button'}
      aria-busy={busy === true ? 'true' : 'false'}
      {...(disabled === true ? { disabled: true } : {})}
    >
      {children as string}
    </button>
  ),
}))

const questions: BatchQuestion[] = [1, 2, 3].map((n) => ({
  id: `q${n}`,
  question: `Question ${n}?`,
  options: [{ id: 'a', label: 'A' }],
  recommendation: null,
  context_md: null,
}))
const whole = (change: Partial<HelpView>): HelpView => ({
  id: 'w1',
  approval_id: 'a1',
  decision: 'question',
  subject: null,
  question_index: null,
  mode: 'suggest_all',
  status: 'succeeded',
  result: {
    mode: 'suggest_all',
    answers: questions.map((q) => ({
      question_id: q.id,
      option_id: 'a',
      reasoning: 'r',
      unsure: 'u',
    })),
  },
  reason: null,
  created_at: '2026-10-20T10:00:00Z',
  ...change,
})

const render = (helps: HelpView[]) =>
  renderToStaticMarkup(
    <BatchForm
      questions={questions}
      approvalId="a1"
      helps={helps}
      onAsk={() => {}}
      onAnnounce={() => {}}
      sending={false}
      onSend={() => {}}
    />,
  )

const buttons = (html: string) =>
  [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => ({
    attrs: m[1]!,
    name: m[2]!,
  }))

describe('the batch form while the whole-batch help runs', () => {
  const html = render([whole({ status: 'running', result: null })])
  const all = buttons(html)

  it('makes every Suggest an answer busy and focusable', () => {
    const suggest = all.filter((b) => b.name === 'Suggest an answer')
    expect(suggest).toHaveLength(3)
    for (const b of suggest) {
      expect(b.attrs).toContain('aria-busy="true"')
      expect(b.attrs).not.toContain('disabled')
    }
  })

  it('leaves Explain simply alone', () => {
    const explain = all.filter((b) => b.name === 'Explain simply')
    expect(explain).toHaveLength(3)
    for (const b of explain) expect(b.attrs).toContain('aria-busy="false"')
  })

  it('shows no Use every answer yet', () => {
    expect(html).not.toContain('Use every answer')
  })
})

describe('the batch form with whole-batch answers', () => {
  const html = render([whole({})])

  it('heads each answer by the whole batch, with its own Use this answer', () => {
    expect(html.match(/Suggested with the whole batch/g)).toHaveLength(3)
    expect(html.match(/Use this answer/g)).toHaveLength(3)
    expect(html).not.toContain('>Suggested answer<')
  })

  it('puts Use every answer after the last question and before Send answers', () => {
    const every = html.indexOf('Use every answer')
    expect(every).toBeGreaterThan(html.lastIndexOf('Question 3 of 3'))
    expect(every).toBeLessThan(html.indexOf('Send answers'))
    expect(html.match(/Use every answer/g)).toHaveLength(1)
    const button = buttons(html).find((b) => b.name === 'Use every answer')
    expect(button?.attrs).toContain('type="button"')
  })

  it('heads a newer own answer as the question’s own', () => {
    const own: HelpView = whole({
      id: 'o1',
      mode: 'suggest',
      question_index: 1,
      result: { mode: 'suggest', text: 'Mine', reasoning: 'r', unsure: 'u' },
      created_at: '2026-10-20T10:05:00Z',
    })
    const mixed = render([whole({}), own])
    expect(mixed.match(/Suggested with the whole batch/g)).toHaveLength(2)
    expect(mixed.match(/>Suggested answer</g)).toHaveLength(1)
    expect(mixed).toContain('Use every answer')
  })
})

describe('the batch form without a whole-batch result', () => {
  it.each<[string, HelpView[]]>([
    ['no help', []],
    ['a failed whole-batch help', [whole({ status: 'failed', result: null, reason: 'x' })]],
  ])('shows no Use every answer with %s', (_name, helps) => {
    expect(render(helps)).not.toContain('Use every answer')
  })
  it('keeps the failure line of a failed whole-batch help', () => {
    const html = render([whole({ status: 'failed', result: null, reason: 'no budget' })])
    expect(html.match(/No suggestion: no budget/g)).toHaveLength(3)
  })
})
