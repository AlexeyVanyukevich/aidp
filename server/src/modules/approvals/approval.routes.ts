import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { TaskParams } from '../tasks/task.schemas.js'
import { AnswerBody, ApprovalParams, ApprovalsQuery, HelpBody } from './approval.schemas.js'
import { ApprovalService } from './approval.service.js'
import { HelpService } from './help.service.js'

export function registerApprovals(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new ApprovalService(app.db, app.clock)
  const helps = new HelpService(app.db, app.bus, app.clock)

  app.get('/api/tasks/:id/approvals', { schema: { params: TaskParams } }, async (request) =>
    service.forTask(request.params.id),
  )

  app.get('/api/tasks/:id/helps', { schema: { params: TaskParams } }, async (request) =>
    helps.forTask(request.params.id),
  )

  app.post(
    '/api/approvals/:id/helps',
    { schema: { params: ApprovalParams, body: HelpBody } },
    async (request, reply) => {
      reply.status(201)
      return helps.create(request.params.id, request.body.question_index ?? null, request.body.mode)
    },
  )

  app.get('/api/approvals', { schema: { querystring: ApprovalsQuery } }, async () => service.open())

  app.post(
    '/api/approvals/:id/answer',
    { schema: { params: ApprovalParams, body: AnswerBody } },
    async (request) => service.answer(request.params.id, request.body),
  )
}
