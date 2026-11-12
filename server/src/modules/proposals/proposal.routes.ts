import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'
import { Uuid } from '../../shared/schemas.js'
import { PROPOSAL_OUTCOMES } from '../../shared/vocabulary.js'
import { TaskParams } from '../tasks/task.schemas.js'
import { ProposalService } from './proposal.service.js'

const SettleParams = Type.Object({ id: Uuid, proposalId: Uuid })

const SettleBody = Type.Object(
  { variant: Type.Union(PROPOSAL_OUTCOMES.map((outcome) => Type.Literal(outcome))) },
  { additionalProperties: false },
)

export function registerProposals(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new ProposalService(app.db, app.clock)

  app.get('/api/tasks/:id/proposals', { schema: { params: TaskParams } }, async (request) =>
    service.listForTask(request.params.id),
  )

  app.post(
    '/api/tasks/:id/proposals/:proposalId/settle',
    { schema: { params: SettleParams, body: SettleBody } },
    async (request) =>
      service.settle(request.params.id, request.params.proposalId, request.body.variant),
  )
}
