import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { TaskParams } from '../tasks/task.schemas.js'
import { SaveSpecBody, SpecParams } from './spec.schemas.js'
import { SpecRepository } from './spec.repository.js'
import { SpecService } from './spec.service.js'

export function registerSpecs(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new SpecService(app.db, new SpecRepository(app.db), app.clock)

  app.get('/api/tasks/:id/specs', { schema: { params: TaskParams } }, async (request) =>
    service.list(request.params.id),
  )

  app.post(
    '/api/tasks/:id/specs',
    { schema: { params: TaskParams, body: SaveSpecBody } },
    async (request, reply) => {
      reply.status(201)
      return service.save(request.params.id, request.body.body_md)
    },
  )

  app.post('/api/specs/:id/approve', { schema: { params: SpecParams } }, async (request) =>
    service.approve(request.params.id),
  )
}
