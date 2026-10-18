import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api'
import { invalidField, isConflict } from '../../src/errors'

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
