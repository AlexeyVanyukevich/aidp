import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type, type Static } from 'typebox'
import { Compile } from 'typebox/compile'
import { HelpActionsService } from '../approvals/help-actions.service.js'
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
  RerunBody,
  ProjectKeyParams,
  RedraftBody,
  ReorderBody,
  TaskParams,
} from './task.schemas.js'
import { TaskService } from './task.service.js'

const SendBackBody = Type.Object(
  { note: Type.String({ maxLength: 4_000 }), help_id: Type.Optional(Uuid) },
  { additionalProperties: false },
)
const rerunBody = Compile(RerunBody)

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

  app.post(
    '/api/projects/:key/tasks/reorder',
    { schema: { params: ProjectKeyParams, body: ReorderBody } },
    async (request) => service.reorder(request.params.key),
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

  // Re-run takes an optional body: a missing one means "plan again" with no note.
  app.post('/api/tasks/:id/actions/rerun', { schema: { params: TaskParams } }, async (request) => {
    // Checked against the schema here, not by Fastify: a missing body is valid.
    const given = request.body ?? {}
    if (!rerunBody.Check(given)) {
      const first = rerunBody.Errors(given)[0]
      const extra = (first?.params as { additionalProperties?: string[] } | undefined)
        ?.additionalProperties?.[0]
      throw new ValidationError(first?.message ?? 'The body is not valid', {
        field: extra ?? first?.instancePath.replace(/^\//, '') ?? 'body',
      })
    }
    const body = given as Static<typeof RerunBody>
    await performAction(app.db, request.params.id, 'rerun', app.clock(), {
      plan: body?.plan ?? 'again',
      note: body?.note ?? null,
    })
    return service.get(request.params.id)
  })

  // Send back: a static path, which wins over `:action`.
  const helpActions = new HelpActionsService(app.db, app.gh, app.clock)
  app.post(
    '/api/tasks/:id/actions/send-back',
    { schema: { params: TaskParams, body: SendBackBody } },
    async (request) => {
      const { note, help_id: helpId } = request.body
      if (note.trim() === '') throw new ValidationError('Say what to change', { field: 'note' })
      await helpActions.sendBack(request.params.id, helpId ?? null, note)
      return service.get(request.params.id)
    },
  )

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
