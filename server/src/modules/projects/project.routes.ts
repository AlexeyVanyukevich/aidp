import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { ProjectRepository } from './project.repository.js'
import { ProjectService } from './project.service.js'
import {
  AddTestCommandBody,
  CreateProjectBody,
  LinkBody,
  LinkParams,
  ProjectKeyParams,
  TestCommandParams,
  UpdateProjectBody,
  UpdateTestCommandBody,
} from './project.schemas.js'

export function registerProjects(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new ProjectService(new ProjectRepository(app.db), app.repoInspector)

  app.get('/api/projects', async () => service.list())

  app.post('/api/projects', { schema: { body: CreateProjectBody } }, async (request, reply) => {
    reply.status(201)
    return service.create(request.body)
  })

  app.patch(
    '/api/projects/:key',
    { schema: { params: ProjectKeyParams, body: UpdateProjectBody } },
    async (request) => service.update(request.params.key, request.body),
  )

  app.post(
    '/api/projects/:key/links',
    { schema: { params: ProjectKeyParams, body: LinkBody } },
    async (request, reply) => {
      await service.addLink(request.params.key, request.body.target, request.body.note)
      reply.status(201)
      return { key: request.params.key, target: request.body.target, note: request.body.note }
    },
  )

  app.delete(
    '/api/projects/:key/links/:target',
    { schema: { params: LinkParams } },
    async (request, reply) => {
      await service.removeLink(request.params.key, request.params.target)
      reply.status(204)
    },
  )

  app.get(
    '/api/projects/:key/test-commands',
    { schema: { params: ProjectKeyParams } },
    async (request) => service.testCommands(request.params.key),
  )

  app.post(
    '/api/projects/:key/test-commands',
    { schema: { params: ProjectKeyParams, body: AddTestCommandBody } },
    async (request, reply) => {
      const added = await service.addTestCommand(request.params.key, request.body)
      reply.status(201)
      return added
    },
  )

  app.patch(
    '/api/projects/:key/test-commands/:id',
    { schema: { params: TestCommandParams, body: UpdateTestCommandBody } },
    async (request) =>
      service.updateTestCommand(request.params.key, request.params.id, request.body),
  )

  app.delete(
    '/api/projects/:key/test-commands/:id',
    { schema: { params: TestCommandParams } },
    async (request, reply) => {
      await service.removeTestCommand(request.params.key, request.params.id)
      reply.status(204)
    },
  )
}
