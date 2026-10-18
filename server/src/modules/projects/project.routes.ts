import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { ProjectRepository } from './project.repository.js'
import { ProjectService } from './project.service.js'
import { CreateProjectBody } from './project.schemas.js'

export function registerProjects(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new ProjectService(new ProjectRepository(app.db), app.repoInspector)

  app.get('/api/projects', async () => service.list())

  app.post('/api/projects', { schema: { body: CreateProjectBody } }, async (request, reply) => {
    reply.status(201)
    return service.create(request.body)
  })
}
