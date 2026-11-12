import { describe, expect, it } from 'vitest'
import {
  checkTitle,
  descriptionLength,
  filedDescription,
  missingLabels,
  offeredVariants,
  proposedByLine,
  resumeText,
  sameTitle,
  settledSummary,
} from '../../src/modules/proposals/proposal.rules.js'

const full = (open: (l: string) => string) =>
  ['Where', 'Found', 'Problem', 'Impact'].map((l) => `${open(l)} x`).join('\n')

describe('checkTitle', () => {
  const rows: { name: string; raw: string; expected: string | 'error' }[] = [
    { name: 'empty', raw: '', expected: 'error' },
    { name: 'spaces', raw: '   ', expected: 'error' },
    { name: '201', raw: 'a'.repeat(201), expected: 'error' },
    { name: '200', raw: 'a'.repeat(200), expected: 'a'.repeat(200) },
    { name: 'padded 200', raw: `  ${'a'.repeat(200)}`, expected: 'a'.repeat(200) },
    { name: 'padded', raw: '  A title  ', expected: 'A title' },
  ]
  it.each(rows)('$name', ({ raw, expected }) => {
    const result = checkTitle(raw)
    if (expected === 'error') expect('error' in result && result.error).toContain('title')
    else expect(result).toEqual({ title: expected })
  })
})

describe('missingLabels', () => {
  const rows: { name: string; text: string; missing: string[] }[] = [
    { name: 'colon inside', text: full((l) => `**${l}:**`), missing: [] },
    { name: 'colon outside', text: full((l) => `**${l}**:`), missing: [] },
    {
      name: 'mixed',
      text: `**Where:** a\n**Found**: b\n**Problem:** c\n**Impact**: d`,
      missing: [],
    },
    { name: 'dash', text: full((l) => `- **${l}:**`), missing: [] },
    { name: 'star', text: full((l) => `* **${l}:**`), missing: [] },
    { name: 'plus', text: full((l) => `+ **${l}:**`), missing: [] },
    {
      name: 'impact missing',
      text: `**Where:** a\n**Found:** b\n**Problem:** c`,
      missing: ['Impact'],
    },
    {
      name: 'found mid-line',
      text: `**Where:** a\nsee **Found:** b\n**Problem:** c\n**Impact:** d`,
      missing: ['Found'],
    },
    {
      name: 'lower case',
      text: `**where:** a\n**Found:** b\n**Problem:** c\n**Impact:** d`,
      missing: ['Where'],
    },
    { name: 'empty', text: '', missing: ['Where', 'Found', 'Problem', 'Impact'] },
  ]
  it.each(rows)('$name', ({ text, missing }) => {
    expect(missingLabels(text)).toEqual(missing)
  })
})

describe('sameTitle', () => {
  it.each([
    { a: '  radio CANNOT be unticked ', b: 'Radio cannot be unticked', same: true },
    { a: 'one', b: 'two', same: false },
  ])('$a vs $b', ({ a, b, same }) => expect(sameTitle(a, b)).toBe(same))
})

describe('offeredVariants', () => {
  const rows: {
    name: string
    related: boolean
    hasWorkaround: boolean
    approval: 'open' | 'expired' | 'withdrawn' | null
    offered: string[]
  }[] = [
    {
      name: 'unrelated',
      related: false,
      hasWorkaround: false,
      approval: null,
      offered: ['file', 'dismiss'],
    },
    {
      name: 'related open',
      related: true,
      hasWorkaround: false,
      approval: 'open',
      offered: ['file', 'dismiss'],
    },
    {
      name: 'workaround open',
      related: true,
      hasWorkaround: true,
      approval: 'open',
      offered: ['file', 'workaround', 'dismiss'],
    },
    {
      name: 'workaround expired',
      related: true,
      hasWorkaround: true,
      approval: 'expired',
      offered: ['file', 'workaround', 'dismiss'],
    },
    {
      name: 'workaround withdrawn',
      related: true,
      hasWorkaround: true,
      approval: 'withdrawn',
      offered: ['file', 'dismiss'],
    },
  ]
  it.each(rows)('$name', ({ offered, ...input }) => {
    const result = offeredVariants(input)
    expect(result).toEqual(offered)
    expect(result).not.toContain('wait')
  })
})

describe('texts', () => {
  it('builds the proposed-by line', () => {
    const input = { taskKey: 'AIDP-95', kind: 'delivery', runNumber: 2, phase: 'build' }
    expect(proposedByLine({ ...input, outcome: 'file' })).toBe(
      'Proposed by AIDP-95, Run 2, build; filed by the owner.',
    )
    expect(proposedByLine({ ...input, outcome: 'workaround' })).toBe(
      'Proposed by AIDP-95, Run 2, build; filed by the owner, and AIDP-95 goes on with a workaround.',
    )
    expect(filedDescription('body  \n', 'L')).toBe('body\n\nL')
    expect(descriptionLength('x', input)).toBeGreaterThan(100)
  })

  const resume: { outcome: 'file' | 'workaround' | 'dismiss'; phase: string; text: string }[] = [
    {
      outcome: 'file',
      phase: 'spec',
      text: 'The owner filed AIDP-7: T. Go on with the task unchanged, and name AIDP-7 in your summary.',
    },
    {
      outcome: 'workaround',
      phase: 'plan',
      text: 'The owner filed AIDP-7: T, and chose your workaround. Carry it in the plan, naming AIDP-7. The workaround: W',
    },
    {
      outcome: 'dismiss',
      phase: 'spec',
      text: 'The owner dismissed the proposal "T"; nothing was filed. Go on with the task unchanged.',
    },
  ]
  it.each(resume)('resume $outcome', ({ outcome, phase, text }) => {
    expect(resumeText({ outcome, phase, key: 'AIDP-7', title: 'T', workaround: 'W' })).toBe(text)
  })

  it('summarises settles', () => {
    expect(settledSummary('file', 'AIDP-7', 'T')).toBe('Filed AIDP-7: T')
    expect(settledSummary('workaround', 'AIDP-7', 'T')).toBe('Filed AIDP-7 with the workaround: T')
    expect(settledSummary('dismiss', null, 'T')).toBe('Dismissed: T')
  })
})
