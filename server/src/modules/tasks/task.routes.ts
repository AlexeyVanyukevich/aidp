import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { ProjectRepository } from '../projects/project.repository.js'
import { TaskRepository } from './task.repository.js'
import { CreateTaskBody, PatchTaskBody, ProjectKeyParams, TaskParams } from './task.schemas.js'
import { TaskService } from './task.service.js'

export function registerTasks(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new TaskService(app.db, new TaskRepository(app.db), new ProjectRepository(app.db))

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
}
