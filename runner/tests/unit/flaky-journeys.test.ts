import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flakyBlock, readReport } from '../../scripts/flaky-journeys.js'

// The shape is Playwright's JSON report as it wrote one for a small spec set with retries on,
// trimmed to the fields the script reads.
const spec = (title: string, file: string, line: number, status: string) => ({
  title,
  file,
  line,
  tests: [{ status }],
})
const REPORT = {
  suites: [
    {
      title: 'a.spec.ts',
      file: 'a.spec.ts',
      specs: [
        spec('passes', 'a.spec.ts', 3, 'expected'),
        spec('skipped', 'a.spec.ts', 4, 'skipped'),
        spec('fails', 'a.spec.ts', 5, 'unexpected'),
      ],
      suites: [
        {
          title: 'Spec view',
          suites: [{ title: 'editor', specs: [spec('saves', 'a.spec.ts', 8, 'flaky')] }],
        },
      ],
    },
    {
      title: 'b.spec.ts',
      file: 'b.spec.ts',
      suites: [{ title: 'PR tab', specs: [spec('refreshes', 'b.spec.ts', 4, 'flaky')] }],
    },
  ],
}

const cases: { name: string; report: unknown; lines: string[] }[] = [
  {
    name: 'one flaky test in a nested describe',
    report: { suites: [REPORT.suites[0]] },
    lines: ['Flaky journeys:', '- a.spec.ts:8 › Spec view › editor › saves'],
  },
  {
    name: 'two flaky tests in two files, in report order',
    report: REPORT,
    lines: [
      'Flaky journeys:',
      '- a.spec.ts:8 › Spec view › editor › saves',
      '- b.spec.ts:4 › PR tab › refreshes',
    ],
  },
  {
    name: 'only passed, failed and skipped tests',
    report: {
      suites: [{ title: 'a.spec.ts', specs: REPORT.suites[0]?.specs }],
    },
    lines: ['Flaky journeys:', 'No journey was flaky.'],
  },
  {
    name: 'a missing report',
    report: null,
    lines: ['Flaky journeys:', 'No journey report was written.'],
  },
]

describe('flakyBlock', () => {
  it.each(cases)('$name', ({ report, lines }) => {
    expect(flakyBlock(report)).toEqual(lines)
  })
})

const dir = mkdtempSync(join(tmpdir(), 'flaky-'))
writeFileSync(join(dir, 'bad.json'), '{not json')

const files: { name: string; path: string }[] = [
  { name: 'a missing report file', path: join(dir, 'none.json') },
  { name: 'a report that is not valid JSON', path: join(dir, 'bad.json') },
]

describe('readReport', () => {
  it.each(files)('$name gives no journey report', ({ path }) => {
    expect(flakyBlock(readReport(path))).toEqual([
      'Flaky journeys:',
      'No journey report was written.',
    ])
  })
})
