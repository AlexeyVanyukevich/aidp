import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '../../src/api'

afterEach(() => vi.unstubAllGlobals())

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  )
}

describe('api', () => {
  it('returns the parsed body of a success', async () => {
    respond(200, [{ key: 'PAY' }])
    expect(await api.projects()).toEqual([{ key: 'PAY' }])
  })

  it.each([
    [
      400,
      { error: 'validation_error', message: 'm', details: { field: 'key' } },
      'validation_error',
      { field: 'key' },
    ],
    [409, { error: 'conflict', message: 'stale' }, 'conflict', undefined],
    [502, 'not json at all', 'bad_gateway', undefined],
  ])('turns a %s into an ApiError with its code', async (status, body, code, details) => {
    respond(status, body)
    const error = await api.projects().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status, code, details })
  })

  it('sends a redraft with its note', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 't' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await api.redraft('t', 'Say how long.')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/tasks/t/actions/redraft')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ note: 'Say how long.' })
  })

  it('reads every page of a run’s events', async () => {
    const pages = [
      { events: [{ id: 'a' }], next: 'c1' },
      { events: [{ id: 'b' }], next: null },
    ]
    const fetchMock = vi.fn(
      async (_url: string) => new Response(JSON.stringify(pages.shift()), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect((await api.events('r')).map((e) => e.id)).toEqual(['a', 'b'])
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('after=c1')
  })
})
