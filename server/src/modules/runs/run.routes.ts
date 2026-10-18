import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'
import { Uuid } from '../../shared/schemas.js'
import { TaskParams } from '../tasks/task.schemas.js'
import { RunRepository } from './run.repository.js'
import { RunService } from './run.service.js'

const RunParams = Type.Object({ id: Uuid })
const EventsQuery = Type.Object(
  {
    after: Type.Optional(Type.String({ maxLength: 100 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
)

export function registerRuns(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new RunService(new RunRepository(app.db))

  app.get('/api/tasks/:id/runs', { schema: { params: TaskParams } }, async (request) =>
    service.forTask(request.params.id),
  )
  app.get('/api/runs/:id', { schema: { params: RunParams } }, async (request) =>
    service.get(request.params.id),
  )
  app.get(
    '/api/runs/:id/events',
    { schema: { params: RunParams, querystring: EventsQuery } },
    async (request) =>
      service.events(request.params.id, request.query.after, request.query.limit ?? 500),
  )
}
