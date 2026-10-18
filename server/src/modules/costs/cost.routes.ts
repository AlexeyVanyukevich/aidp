import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { TaskParams } from '../tasks/task.schemas.js'
import { CostService } from './cost.service.js'

export function registerCosts(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new CostService(app.db)
  app.get('/api/tasks/:id/costs', { schema: { params: TaskParams } }, async (request) =>
    service.forTask(request.params.id),
  )
}
