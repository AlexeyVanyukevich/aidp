import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CostTab } from '../../src/card/CostTab'
import type { CostSummary, TaskView } from '../../src/types'

// The kit's published build imports without file extensions, which Node cannot load here; the
// table under test uses only these three widgets.
vi.mock('@zellige/react', () => ({
  Badge: ({ children }: { children?: unknown }) => <span>{children as string}</span>,
  Loading: () => <p>Loading</p>,
  Trouble: ({ title }: { title: string }) => <p>{title}</p>,
}))

const usage = (n: number) => ({ input: n, output: n, cacheRead: 0, cacheWrite: 0 })
const phase = (
  over: Partial<CostSummary['byPhase'][number]> &
    Pick<CostSummary['byPhase'][number], 'phaseId' | 'name'>,
): CostSummary['byPhase'][number] => ({
  attempt: 1,
  usage: usage(1000),
  usd: 0.5,
  reportedUsd: null,
  drift: null,
  flagged: false,
  interrupted: false,
  cut: false,
  run: null,
  ...over,
})

interface Row {
  name: string
  run: { kind: string; number: number }
  label: string
}
const ROWS: Row[] = [
  { name: 'a Help phase of a delivery run', run: { kind: 'delivery', number: 2 }, label: 'Run 2' },
  { name: 'a Help phase of a draft', run: { kind: 'spec', number: 3 }, label: 'Draft 3' },
]

function render(summary: CostSummary): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['costs', 't1'], summary)
  client.setQueryData(['runs', 't1'], [])
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CostTab task={{ id: 't1' } as TaskView} />
    </QueryClientProvider>,
  )
}

describe('the Cost tab and a Help phase', () => {
  it.each(ROWS)('lists $name under its asking run with its cost', ({ run, label }) => {
    const html = render({
      totals: { usage: usage(2000), usd: 1 },
      byPhase: [
        phase({ phaseId: 'p1', name: 'build', run }),
        phase({ phaseId: 'p2', name: 'help', run }),
      ],
      byAgent: [],
      byModel: [],
      cacheHitRatio: null,
      missingPrices: [],
    })
    expect(html).toContain('Help 1')
    expect(html).toContain(`· ${label}`)
    // The task's total includes the Help phase's cost.
    expect(html).toContain('Total $1.00')
    expect(html.match(/\$0\.50/g)).toHaveLength(2)
  })

  it('does not name a run beside a phase that is not a Help phase', () => {
    const html = render({
      totals: { usage: usage(1000), usd: 0.5 },
      byPhase: [phase({ phaseId: 'p1', name: 'build', run: { kind: 'delivery', number: 1 } })],
      byAgent: [],
      byModel: [],
      cacheHitRatio: null,
      missingPrices: [],
    })
    expect(html).not.toContain('Run 1')
  })
})
