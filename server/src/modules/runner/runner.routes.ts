import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { UnauthorizedError } from '../../shared/errors.js'
import { bearer, resolveRunToken, sameSecret } from '../../shared/tokens.js'
import { ClaimBody, EventsBody, HeartbeatBody, RunParams } from './runner.schemas.js'
import { RunnerService } from './runner.service.js'

declare module 'fastify' {
  interface FastifyRequest {
    runContext: { runId: string; taskId: string } | null
  }
}

export function registerRunner(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new RunnerService(app.db, app.bus, app.clock)
  app.decorateRequest('runContext', null)

  const runnerKey = async (request: FastifyRequest) => {
    const token = bearer(request.headers.authorization)
    if (token === undefined || !sameSecret(token, app.config.runnerKey))
      throw new UnauthorizedError()
  }
  const runToken = async (request: FastifyRequest) => {
    request.runContext = await resolveRunToken(app.db, request.headers.authorization, app.clock())
  }
  const context = (request: FastifyRequest) => {
    if (request.runContext === null) throw new UnauthorizedError()
    return request.runContext
  }

  app.post(
    '/api/runner/claim',
    { preHandler: runnerKey, schema: { body: ClaimBody } },
    async (request) => ({
      work: await service.claim(
        request.body.runner_id,
        request.body.wait_ms ?? app.config.claimWaitMs,
      ),
    }),
  )

  app.post(
    '/api/runner/heartbeat',
    { preHandler: runnerKey, schema: { body: HeartbeatBody } },
    async (request) => service.heartbeat(request.body.runner_id, request.body.run_ids),
  )

  app.post(
    '/api/runner/runs/:id/tokens',
    { preHandler: runnerKey, schema: { params: RunParams } },
    async (request) => service.issueToken(request.params.id),
  )

  app.post(
    '/api/runner/events',
    { preHandler: runToken, schema: { body: EventsBody } },
    async (request) => service.ingest(context(request), request.body.events),
  )

  app.post('/api/runner/tokens/retire', { preHandler: runToken }, async (request, reply) => {
    await service.retire(bearer(request.headers.authorization) ?? '')
    reply.status(204)
  })
}
