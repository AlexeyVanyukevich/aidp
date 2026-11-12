import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api'
import { answerRefusal, invalidField, isConflict } from '../../src/errors'

const refused = (details?: Record<string, unknown>) =>
  new ApiError(400, 'validation_error', 'm', details)

describe('invalidField', () => {
  it.each([
    ['the field a service check names', refused({ field: 'repo_path' }), 'repo_path'],
    ['the first schema issue’s path', refused({ issues: [{ instancePath: '/key' }] }), 'key'],
    [
      'a required field the schema missed',
      refused({ issues: [{ instancePath: '', params: { missingProperty: 'name' } }] }),
      'name',
    ],
    ['a refusal that names no field', refused(), undefined],
    ['a conflict', new ApiError(409, 'conflict', 'm'), undefined],
    ['anything that is not an ApiError', new Error('network'), undefined],
  ])('finds %s', (_name, error, field) => {
    expect(invalidField(error)).toBe(field)
  })
})

describe('isConflict', () => {
  it.each([
    [new ApiError(409, 'conflict', 'm'), true],
    [refused(), false],
    [new Error('x'), false],
  ])('%#', (error, expected) => {
    expect(isConflict(error)).toBe(expected)
  })
})

describe('answerRefusal', () => {
  const LENGTH = 'The answer is longer than 4,000 characters.'
  const NOT_ALLOWED =
    'Approving the plan carries no words. Clear them, or press Clear choice to ask for changes.'
  it.each([
    [
      'a service not_allowed',
      refused({ field: 'text', findings: [{ field: 'text', code: 'not_allowed' }] }),
      NOT_ALLOWED,
    ],
    [
      'a service too_long',
      refused({ field: 'text', findings: [{ field: 'text', code: 'too_long' }] }),
      LENGTH,
    ],
    [
      'a schema maxLength',
      refused({ issues: [{ instancePath: '/text', keyword: 'maxLength' }] }),
      LENGTH,
    ],
    ['a conflict', new ApiError(409, 'conflict', 'm'), undefined],
    ['a server error', new ApiError(500, 'internal', 'm'), undefined],
  ])('maps %s', (_name, error, expected) => {
    expect(answerRefusal(error)).toBe(expected)
  })
})
