import { describe, expect, it } from 'vitest'
import { RUN_KINDS, PHASE_NAMES, STAGES } from '../../src/shared/vocabulary.js'
import { ClaimBody } from '../../src/modules/runner/runner.schemas.js'
import { Value } from 'typebox/value'

describe('the rephrase vocabulary', () => {
  it.each([
    ['run kinds', RUN_KINDS],
    ['phase names', PHASE_NAMES],
    ['stages', STAGES],
  ] as const)('lists rephrase among the %s', (_name, list) => {
    expect(list as readonly string[]).toContain('rephrase')
  })
})

describe('the claim body', () => {
  it.each([
    [['rephrase'], true],
    [['title', 'rephrase'], true],
    [['spec', 'delivery', 'title', 'rephrase'], true],
    [['rephrase', 'rephrase'], false],
    [['other'], false],
  ] as const)('checks kinds %j', (kinds, valid) => {
    expect(Value.Check(ClaimBody, { runner_id: 'r1', kinds })).toBe(valid)
  })
})
