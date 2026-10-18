import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb } from './helpers.js'
import { publish } from '../../src/shared/bus.js'

let app: FastifyInstance
let base: string

beforeAll(async () => {
  app = await buildTestApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://localhost:${address.port}`
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('the bus', () => {
  it('delivers a published message to a subscriber', async () => {
    const received = app.bus.next('run.queued', 5_000)
    await publish(getTestDb(), { topic: 'run.queued', runId: 'r1' })
    expect(await received).toEqual({ topic: 'run.queued', runId: 'r1' })
  })

  it('delivers nothing from a transaction that rolled back', async () => {
    const received = app.bus.next('run.queued', 500)
    await getTestDb()
      .transaction()
      .execute(async (trx) => {
        await publish(trx, { topic: 'run.queued', runId: 'never' })
        throw new Error('roll back')
      })
      .catch(() => undefined)
    expect(await received).toBeUndefined()
  })
})

describe('GET /api/stream', () => {
  it('forwards task and run messages to the browser', async () => {
    const controller = new AbortController()
    const response = await fetch(`${base}/api/stream`, { signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    await new Promise((done) => setTimeout(done, 100))
    await publish(getTestDb(), { topic: 'task.updated', taskId: 't1' })

    let text = ''
    while (!text.includes('task.updated')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }
    controller.abort()
    expect(text).toContain('event: task.updated\ndata: {"topic":"task.updated","taskId":"t1"}\n\n')
  })
})
