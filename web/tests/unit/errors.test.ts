import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api'
import { noteRefusal, NOTE_TOO_LONG, NO_NOTE, invalidField, isConflict } from '../../src/errors'

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

describe('noteRefusal', () => {
  it.each([
    [
      'a note over the limit',
      refused({ issues: [{ instancePath: '/note', keyword: 'maxLength' }] }),
      NOTE_TOO_LONG,
    ],
    ['a service refusal naming the note', refused({ field: 'note' }), NO_NOTE],
    [
      'another schema issue on the note',
      refused({ issues: [{ instancePath: '/note', keyword: 'type' }] }),
      NO_NOTE,
    ],
    [
      'a maxLength issue on another field',
      refused({ issues: [{ instancePath: '/text', keyword: 'maxLength' }] }),
      undefined,
    ],
    ['a conflict', new ApiError(409, 'conflict', 'm'), undefined],
    ['a server error', new ApiError(500, 'internal_error', 'm'), undefined],
    ['anything that is not an ApiError', new Error('network'), undefined],
  ])('picks the message for %s', (_name, error, message) => {
    expect(noteRefusal(error)).toBe(message)
  })

  it('words the messages as the page shows them', () => {
    expect(NOTE_TOO_LONG).toBe('The note is longer than 4,000 characters.')
    expect(NO_NOTE).toBe('Say what to change.')
  })
})
