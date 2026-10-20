import type { FastifyInstance } from 'fastify'

const FORWARDED = new Set([
  'task.updated',
  'run.event',
  'approval.requested',
  'approval.answered',
  'resync',
])

export function registerStream(app: FastifyInstance): void {
  app.get('/api/stream', (request, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    raw.write(': connected\n\n')

    const unsubscribe = app.bus.subscribe((message) => {
      if (!FORWARDED.has(message.topic)) return
      raw.write(`event: ${message.topic}\ndata: ${JSON.stringify(message)}\n\n`)
    })
    // A comment line every 15 s keeps proxies and the browser from timing the stream out.
    const keepAlive = setInterval(() => raw.write(': keep-alive\n\n'), 15_000)

    request.raw.on('close', () => {
      clearInterval(keepAlive)
      unsubscribe()
    })
  })
}
