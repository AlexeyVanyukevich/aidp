import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, BoardApi } from '../../src/api.js'
import { loadRunnerConfig } from '../../src/config.js'

/** A board that accepts the connection and never answers — as a socket left dead by a sleep. */
const silent: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the board client', () => {
  it.each([
    {
      name: 'a claim waiting 1 s',
      call: (api: BoardApi) => api.claim('r1', 1_000),
      limitMs: 11_000,
    },
    { name: 'a heartbeat', call: (api: BoardApi) => api.heartbeat('r1', []), limitMs: 30_000 },
    { name: 'a token', call: (api: BoardApi) => api.issueToken('run'), limitMs: 30_000 },
  ])(
    'gives up on $name after $limitMs ms, as a failure worth retrying',
    async ({ call, limitMs }) => {
      const api = new BoardApi('http://board', 'key', silent)
      const outcome = call(api).then(
        () => 'answered',
        (error: unknown) => error,
      )
      await vi.advanceTimersByTimeAsync(limitMs - 1)
      expect(await Promise.race([outcome, Promise.resolve('waiting')])).toBe('waiting')
      await vi.advanceTimersByTimeAsync(1)
      const error = await outcome
      // The event sink retries a TypeError, as it does an unreachable board.
      expect(error).toBeInstanceOf(TypeError)
      expect(String(error)).toMatch(/did not answer within/)
    },
  )

  it('keeps the parsed body of a refused request', async () => {
    const body = { error: 'validation_error', details: { findings: [{ field: 'x', code: 'y' }] } }
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body), { status: 400 })) as typeof fetch
    const error = await new BoardApi('http://board', 'key', fetchImpl)
      .sendEvents('t', [])
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 400, body })
    expect((error as Error).message).toContain('answered 400')
  })

  it('hands back the runs to stop and the runs that paused', async () => {
    vi.useRealTimers()
    const answering: typeof fetch = async () =>
      new Response(JSON.stringify({ cancel: ['a'], pause: ['b'] }), { status: 200 })
    const api = new BoardApi('http://board', 'key', answering)
    expect(await api.heartbeat('r1', ['a', 'b'])).toEqual({ cancel: ['a'], pause: ['b'] })
  })
})

describe('the runner’s timing configuration', () => {
  const base = { RUNNER_KEY: 'k' }
  it('defaults to a 60 s pause grace, a 10 s stop grace and a 500 ms marker poll', () => {
    expect(loadRunnerConfig(base)).toMatchObject({
      pauseGraceMs: 60_000,
      stopGraceMs: 10_000,
      markerPollMs: 500,
    })
  })

  it.each([
    ['PAUSE_GRACE_MS', 'pauseGraceMs'],
    ['STOP_GRACE_MS', 'stopGraceMs'],
    ['MARKER_POLL_MS', 'markerPollMs'],
  ] as const)('reads %s', (key, field) => {
    expect(loadRunnerConfig({ ...base, [key]: '200' })[field]).toBe(200)
  })
})
