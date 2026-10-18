import { Type } from 'typebox'

/**
 * `minLength: 1` accepts `"   "`, which then reaches a check constraint as a 500. One non-space
 * character keeps the refusal at the boundary, where it can name the field.
 */
export function NonBlankString(options: { maxLength: number }) {
  return Type.String({ minLength: 1, pattern: '\\S', maxLength: options.maxLength })
}

export const Uuid = Type.String({ format: 'uuid' })
