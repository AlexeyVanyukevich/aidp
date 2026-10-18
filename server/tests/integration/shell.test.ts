import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp({}, (instance) => {
    // A route that writes, to exercise the origin check without a feature.
    instance.post('/api/echo', async (request) => request.body)
    instance.get('/api/boom', async () => {
      throw new Error('table "secret_structure" does not exist')
    })
  })
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('the shell', () => {
  it('answers health', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('answers an unknown API path in the shared shape', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('not_found')
  })

  it('never leaks an unexpected error', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/boom' })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: 'internal_error', message: 'Internal server error' })
  })

  it('translates a malformed JSON body into bad_request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"oops',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('bad_request')
  })

  it.each([
    ['a foreign Host', { host: 'evil.example' }, 'GET', 403],
    ['a write from another site', { origin: 'https://evil.example' }, 'POST', 403],
    ['a write from the app itself', { origin: 'http://localhost:80' }, 'POST', 200],
    ['a write with no Origin', {}, 'POST', 200],
  ] as const)('%s', async (_name, headers, method, status) => {
    const response = await app.inject({
      method,
      url: method === 'GET' ? '/api/health' : '/api/echo',
      headers: { ...headers },
      ...(method === 'POST' ? { payload: { a: 1 } } : {}),
    })
    expect(response.statusCode).toBe(status)
    if (status === 403) expect(response.json().error).toBe('forbidden_origin')
  })
})
