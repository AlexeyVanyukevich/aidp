import { describe, expect, it } from 'vitest'
import { bearer, hashToken, newToken, sameSecret } from '../../src/shared/tokens.js'

describe('tokens', () => {
  it('issues a token whose hash is what is stored', () => {
    const { token, hash } = newToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(hashToken(token)).toBe(hash)
    expect(newToken().token).not.toBe(token)
  })

  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['Bearer', undefined],
    ['Basic abc', undefined],
    [undefined, undefined],
  ])('bearer(%s) → %s', (header, expected) => {
    expect(bearer(header)).toBe(expected)
  })

  it.each([
    ['equal', 'k'.repeat(40), 'k'.repeat(40), true],
    ['different', 'k'.repeat(40), 'j'.repeat(40), false],
    ['different lengths', 'k'.repeat(40), 'k'.repeat(39), false],
  ])('sameSecret: %s', (_name, a, b, expected) => {
    expect(sameSecret(a, b)).toBe(expected)
  })
})
