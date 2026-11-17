import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Compile } from 'typebox/compile'
import type { Static } from 'typebox'
import { ValidationError } from '../../shared/errors.js'
import { TaskParams } from '../tasks/task.schemas.js'
import { ApproveBody, SaveSpecBody, SpecParams } from './spec.schemas.js'
import { SpecRepository } from './spec.repository.js'
import { SpecService } from './spec.service.js'

const approveBody = Compile(ApproveBody)

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

  // Approve takes an optional body: a missing one approves with no note.
  app.post('/api/specs/:id/approve', { schema: { params: SpecParams } }, async (request) => {
    // Checked here, not by Fastify: a missing body is valid.
    const given = request.body ?? {}
    if (!approveBody.Check(given)) {
      const first = approveBody.Errors(given)[0]
      const extra = (first?.params as { additionalProperties?: string[] } | undefined)
        ?.additionalProperties?.[0]
      throw new ValidationError(first?.message ?? 'The body is not valid', {
        field: extra ?? first?.instancePath.replace(/^\//, '') ?? 'body',
      })
    }
    return service.approve(request.params.id, (given as Static<typeof ApproveBody>).note)
  })
}
