import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'
import { Uuid } from '../../shared/schemas.js'
import { TaskParams } from '../tasks/task.schemas.js'
import { AnswerBody, ApprovalParams, ApprovalsQuery, HelpBody } from './approval.schemas.js'
import { ApprovalService } from './approval.service.js'
import { HelpService } from './help.service.js'

/** A decision help's body: a proposal's help also names the proposal it is for. */
const DecisionHelpBody = Type.Object(
  { decision: Type.String(), mode: Type.String(), proposal_id: Type.Optional(Uuid) },
  { additionalProperties: false },
)

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

  app.post(
    '/api/tasks/:id/helps',
    { schema: { params: TaskParams, body: DecisionHelpBody } },
    async (request, reply) => {
      reply.status(201)
      return helps.createForDecision(
        request.params.id,
        request.body.decision,
        request.body.mode,
        request.body.proposal_id,
      )
    },
  )

  app.get('/api/approvals', { schema: { querystring: ApprovalsQuery } }, async () => service.open())

  app.post(
    '/api/approvals/:id/answer',
    { schema: { params: ApprovalParams, body: AnswerBody } },
    async (request) => service.answer(request.params.id, request.body),
  )
}
