import { describe, expect, it } from 'vitest'
import { childEnv } from '../../src/child-env.js'

interface Row {
  key: string
  removed: boolean
}

const ROWS: Row[] = [
  { key: 'RUNNER_KEY', removed: true },
  { key: 'DATABASE_URL', removed: true },
  { key: 'PORT', removed: true },
  { key: 'BOARD_URL', removed: true },
  { key: 'BOARD_HOME', removed: true },
  { key: 'BOARD_RUN_TOKEN', removed: true },
  { key: 'BOARD', removed: false },
  { key: 'PATH', removed: false },
  { key: 'HOME', removed: false },
  { key: 'SMOKE_REPO_PATH', removed: false },
  { key: 'GITHUB_TOKEN', removed: false },
  { key: 'DATABASE_URL_EXTRA', removed: false },
]

describe('childEnv', () => {
  it.each(ROWS)('$key: removed is $removed', ({ key, removed }) => {
    const result = childEnv({ [key]: 'value' })
    if (removed) expect(result).not.toHaveProperty(key)
    else expect(result[key]).toBe('value')
  })

  it('returns a new object and leaves its input alone', () => {
    const input = { RUNNER_KEY: 'k', PATH: '/bin' }
    const result = childEnv(input)
    expect(result).not.toBe(input)
    expect(input).toEqual({ RUNNER_KEY: 'k', PATH: '/bin' })
  })
})
