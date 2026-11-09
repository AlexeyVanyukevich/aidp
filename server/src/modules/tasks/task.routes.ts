import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'
import { ValidationError } from '../../shared/errors.js'
import { Uuid } from '../../shared/schemas.js'
import { CostService } from '../costs/cost.service.js'
import { ProjectRepository } from '../projects/project.repository.js'
import { RunRepository } from '../runs/run.repository.js'
import {
  ACTIONS,
  cancelRephrase,
  decideSuggestion,
  decideTitle,
  performAction,
  redraft,
  rephraseDescription,
  rephraseTitle,
  stopTitle,
} from './task.actions.js'
import { TaskRepository } from './task.repository.js'
import {
  AcceptSuggestionBody,
  AcceptTitleBody,
  CreateTaskBody,
  PatchTaskBody,
  ProjectKeyParams,
  RedraftBody,
  TaskParams,
} from './task.schemas.js'
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

  // Re-run takes an optional body, checked by hand: a missing one means "plan again".
  app.post('/api/tasks/:id/actions/rerun', { schema: { params: TaskParams } }, async (request) => {
    const body = request.body as { plan?: unknown } | null | undefined
    const plan = body?.plan ?? 'again'
    if (
      (body !== null && body !== undefined && typeof body !== 'object') ||
      (plan !== 'keep' && plan !== 'again')
    )
      throw new ValidationError('plan must be "keep" or "again"', { field: 'plan' })
    await performAction(app.db, request.params.id, 'rerun', app.clock(), plan)
    return service.get(request.params.id)
  })

  // The one action with a body; a static path, so it wins over `:action` (slice 3 spec, §8).
  app.post(
    '/api/tasks/:id/actions/redraft',
    { schema: { params: TaskParams, body: RedraftBody } },
    async (request) => {
      await redraft(app.db, request.params.id, request.body.note, app.clock())
      return service.get(request.params.id)
    },
  )

  // The title actions: static paths, which win over `:action`. None moves the card.
  app.post(
    '/api/tasks/:id/actions/rephrase-title',
    { schema: { params: TaskParams } },
    async (request) => {
      await rephraseTitle(app.db, request.params.id, app.clock())
      return service.get(request.params.id)
    },
  )
  app.post(
    '/api/tasks/:id/actions/stop-title',
    { schema: { params: TaskParams } },
    async (request) => {
      await stopTitle(app.db, request.params.id, app.clock())
      return service.get(request.params.id)
    },
  )
  app.post(
    '/api/tasks/:id/actions/accept-title',
    { schema: { params: TaskParams, body: AcceptTitleBody } },
    async (request) => {
      await decideTitle(app.db, request.params.id, { accept: request.body.title })
      return service.get(request.params.id)
    },
  )
  app.post(
    '/api/tasks/:id/actions/discard-title',
    { schema: { params: TaskParams } },
    async (request) => {
      await decideTitle(app.db, request.params.id, 'discard')
      return service.get(request.params.id)
    },
  )

  // The description actions: static paths too. None moves the card.
  app.post(
    '/api/tasks/:id/actions/rephrase',
    { schema: { params: TaskParams } },
    async (request) => {
      await rephraseDescription(app.db, request.params.id, app.clock())
      return service.get(request.params.id)
    },
  )
  app.post(
    '/api/tasks/:id/actions/cancel-rephrase',
    { schema: { params: TaskParams } },
    async (request) => {
      await cancelRephrase(app.db, request.params.id, app.clock())
      return service.get(request.params.id)
    },
  )
  app.post(
    '/api/tasks/:id/suggestion/accept',
    { schema: { params: TaskParams, body: AcceptSuggestionBody } },
    async (request) => {
      await decideSuggestion(
        app.db,
        request.params.id,
        { accept: request.body.description_md },
        app.clock(),
      )
      return service.get(request.params.id)
    },
  )
  app.post(
    '/api/tasks/:id/suggestion/discard',
    { schema: { params: TaskParams } },
    async (request) => {
      await decideSuggestion(app.db, request.params.id, 'discard', app.clock())
      return service.get(request.params.id)
    },
  )
}
