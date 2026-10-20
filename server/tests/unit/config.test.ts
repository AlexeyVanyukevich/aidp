import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

const BASE = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5435/board',
  RUNNER_KEY: 'k'.repeat(32),
}

describe('loadConfig', () => {
  it('fills the defaults', () => {
    expect(loadConfig(BASE)).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      port: 4100,
      host: '127.0.0.1',
      allowedHosts: ['localhost', '127.0.0.1'],
      runnerKey: BASE.RUNNER_KEY,
      logLevel: 'info',
      prPollMs: 180_000,
      claimWaitMs: 30_000,
      sweepMs: 60_000,
    })
  })

  it('reads how often the sweeper runs', () => {
    expect(loadConfig({ ...BASE, SWEEP_MS: '5000' }).sweepMs).toBe(5_000)
  })

  it('reads a comma-separated host list, trimmed and lower-cased', () => {
    const config = loadConfig({ ...BASE, ALLOWED_HOSTS: ' localhost, Board.Local ' })
    expect(config.allowedHosts).toEqual(['localhost', 'board.local'])
  })

  it.each([
    ['no database', { ...BASE, DATABASE_URL: '' }, /DATABASE_URL is required/],
    ['no runner key', { ...BASE, RUNNER_KEY: '' }, /RUNNER_KEY is required/],
    ['a short runner key', { ...BASE, RUNNER_KEY: 'short' }, /RUNNER_KEY must be/],
    ['a port that is not a number', { ...BASE, PORT: 'abc' }, /PORT must be/],
    ['a port of zero', { ...BASE, PORT: '0' }, /PORT must be/],
    ['a sweep interval of zero', { ...BASE, SWEEP_MS: '0' }, /SWEEP_MS must be/],
    ['an empty host list', { ...BASE, ALLOWED_HOSTS: ' , ' }, /ALLOWED_HOSTS/],
  ])('refuses %s', (_name, env, message) => {
    expect(() => loadConfig(env)).toThrow(message)
  })
})
