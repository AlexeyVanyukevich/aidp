import { describe, expect, it } from 'vitest'
import { isAllowedHost, isSameOrigin } from '../../src/shared/hosts.js'

const ALLOWED = ['localhost', '127.0.0.1']

describe('isAllowedHost', () => {
  it.each([
    ['localhost:4100', true],
    ['127.0.0.1:4100', true],
    ['LOCALHOST:4100', true],
    ['localhost', true],
    // DNS rebinding: an attacker's name resolving to 127.0.0.1 arrives with its own Host.
    ['evil.example:4100', false],
    ['localhost.evil.example', false],
    ['[::1]:4100', false],
    [undefined, false],
    ['', false],
  ])('%s → %s', (host, expected) => {
    expect(isAllowedHost(host, ALLOWED)).toBe(expected)
  })
})

describe('isSameOrigin', () => {
  it.each([
    ['no Origin header (curl, the runner)', undefined, 'localhost:4100', true],
    ['the app itself', 'http://localhost:4100', 'localhost:4100', true],
    ['the default port spelled out in Host', 'http://localhost', 'localhost:80', true],
    ['the default port spelled out in Origin', 'http://localhost:80', 'localhost', true],
    ['a Host in another case', 'http://localhost:4100', 'LocalHost:4100', true],
    ['another site', 'https://evil.example', 'localhost:4100', false],
    ['the same host on another port', 'http://localhost:5174', 'localhost:4100', false],
    ['an Origin that is not a URL', 'null', 'localhost:4100', false],
  ])('%s', (_name, origin, host, expected) => {
    expect(isSameOrigin(origin, host)).toBe(expected)
  })
})
