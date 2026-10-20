import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { TaskParams } from '../tasks/task.schemas.js'
import { AnswerBody, ApprovalParams, ApprovalsQuery } from './approval.schemas.js'
import { ApprovalService } from './approval.service.js'

export function registerApprovals(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new ApprovalService(app.db, app.clock)

  app.get('/api/tasks/:id/approvals', { schema: { params: TaskParams } }, async (request) =>
    service.forTask(request.params.id),
  )

  app.get('/api/approvals', { schema: { querystring: ApprovalsQuery } }, async () => service.open())

  app.post(
    '/api/approvals/:id/answer',
    { schema: { params: ApprovalParams, body: AnswerBody } },
    async (request) => service.answer(request.params.id, request.body),
  )
}
