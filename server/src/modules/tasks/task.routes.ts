import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'
import { Uuid } from '../../shared/schemas.js'
import { CostService } from '../costs/cost.service.js'
import { ProjectRepository } from '../projects/project.repository.js'
import { RunRepository } from '../runs/run.repository.js'
import { ACTIONS, performAction } from './task.actions.js'
import { TaskRepository } from './task.repository.js'
import { CreateTaskBody, PatchTaskBody, ProjectKeyParams, TaskParams } from './task.schemas.js'
import { TaskService } from './task.service.js'

export function registerTasks(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new TaskService(
    app.db,
    new TaskRepository(app.db),
    new ProjectRepository(app.db),
    new RunRepository(app.db),
    new CostService(app.db),
  )

  app.get('/api/projects/:key/tasks', { schema: { params: ProjectKeyParams } }, async (request) =>
    service.board(request.params.key),
  )

  app.post(
    '/api/projects/:key/tasks',
    { schema: { params: ProjectKeyParams, body: CreateTaskBody } },
    async (request, reply) => {
      reply.status(201)
      return service.create(request.params.key, request.body)
    },
  )

  app.get('/api/tasks/:id', { schema: { params: TaskParams } }, async (request) =>
    service.get(request.params.id),
  )

  app.patch(
    '/api/tasks/:id',
    { schema: { params: TaskParams, body: PatchTaskBody } },
    async (request) => service.patch(request.params.id, request.body),
  )

  const ActionParams = Type.Object({
    id: Uuid,
    action: Type.Enum(ACTIONS),
  })
  app.post(
    '/api/tasks/:id/actions/:action',
    { schema: { params: ActionParams } },
    async (request) => {
      await performAction(app.db, request.params.id, request.params.action, app.clock())
      return service.get(request.params.id)
    },
  )
}
