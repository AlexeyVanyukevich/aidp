import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  BATCH_SUGGEST_OPTIONS,
  BatchSuggestions,
  batchSuggestSaved,
  BATCH_SUGGEST_FAILED,
} from '../../src/routes/Settings'

// The kit's published build cannot load in Node here.
vi.mock('@zellige/react', () => ({
  Button: ({ children, type }: { children?: unknown; type?: string }) => (
    <button type={(type ?? 'button') as 'button'}>{children as string}</button>
  ),
  Field: ({ children }: { children?: unknown }) => <div>{children as string}</div>,
  Input: () => <input />,
  Notice: ({ children, tone }: { children?: unknown; tone?: string }) => (
    <div role="status" data-tone={tone}>
      {children as string}
    </div>
  ),
  RadioGroup: ({
    label,
    value,
    children,
  }: {
    label: string
    value: string | null
    children?: unknown
  }) => (
    <div role="radiogroup" aria-label={label} data-value={value}>
      {children as string}
    </div>
  ),
  Radio: ({ value, children }: { value: string; children?: unknown }) => (
    <label data-radio={value}>{children as string}</label>
  ),
  Loading: () => null,
  Trouble: () => null,
}))

describe('batchSuggestSaved and the options', () => {
  it.each([
    ['whole', 'Batch suggestions saved: The whole batch in one help.'],
    ['one', 'Batch suggestions saved: One question at a time.'],
  ] as const)('says %s was saved with the radio’s label', (value, text) => {
    expect(batchSuggestSaved(value)).toBe(text)
  })

  it('offers the two radios by their labels', () => {
    expect(BATCH_SUGGEST_OPTIONS).toEqual([
      { value: 'whole', label: 'The whole batch in one help' },
      { value: 'one', label: 'One question at a time' },
    ])
  })

  it('words the failure', () => {
    expect(BATCH_SUGGEST_FAILED).toBe('The setting could not be saved. Try again.')
  })
})

describe('the Batch suggestions section', () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <BatchSuggestions projectKey="PAY" saved="one" announce={() => {}} />
    </QueryClientProvider>,
  )

  it('is an h2 holding the named radio group, then the button', () => {
    const heading = html.indexOf('<h2>Batch suggestions</h2>')
    const group = html.indexOf('aria-label="How a batch of questions is suggested"')
    const button = html.indexOf('Save batch suggestions')
    expect(heading).toBeGreaterThanOrEqual(0)
    expect(group).toBeGreaterThan(heading)
    expect(button).toBeGreaterThan(group)
  })

  it('checks the saved value', () => {
    expect(html).toContain('data-value="one"')
    expect(html).toContain('The whole batch in one help')
    expect(html).toContain('One question at a time')
  })
})
