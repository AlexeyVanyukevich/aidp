import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { Kysely } from 'kysely'
import type { Config } from './config.js'
import type { Database } from './db/schema.js'
import { registerProjects } from './modules/projects/project.routes.js'
import { createRepoInspector, type RepoInspector } from './modules/projects/repo-inspector.js'
import { ForbiddenOriginError, registerErrorHandler } from './shared/errors.js'
import { isAllowedHost, isSameOrigin } from './shared/hosts.js'

export interface AppDeps {
  config: Config
  db: Kysely<Database>
  /** Injected so sweepers and expiries are testable without waiting. */
  clock?: () => Date
  repoInspector?: RepoInspector
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<Database>
    config: Config
    clock: () => Date
    repoInspector: RepoInspector
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      redact: ['req.headers.authorization'],
    },
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: 5 * 1024 * 1024,
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.decorate('db', deps.db)
  app.decorate('config', deps.config)
  app.decorate('clock', deps.clock ?? (() => new Date()))
  registerErrorHandler(app)
  app.decorate('repoInspector', deps.repoInspector ?? createRepoInspector())

  // No sign-in is not no protection: any page open in the owner's browser can reach 127.0.0.1.
  app.addHook('onRequest', async (request) => {
    if (!isAllowedHost(request.headers.host, deps.config.allowedHosts)) {
      throw new ForbiddenOriginError('This host is not one the board answers to')
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (!isSameOrigin(request.headers.origin, request.headers.host)) {
        throw new ForbiddenOriginError('This request did not come from the board')
      }
    }
  })

  app.get('/api/health', async () => ({ status: 'ok' }))
  registerProjects(app)

  await registerSpa(app)
  return app
}

/**
 * The single-page app is served from the same origin as the API. Unknown non-API paths fall
 * through to index.html so a client-side route survives a reload.
 */
async function registerSpa(app: FastifyInstance): Promise<void> {
  const root = [
    resolve(import.meta.dirname, '../public'),
    resolve(import.meta.dirname, '../../public'),
  ].find((candidate) => existsSync(join(candidate, 'index.html')))

  if (root !== undefined) {
    await app.register(fastifyStatic, { root, index: ['index.html'] })
  } else {
    app.log.warn('no web build to serve; run npm run --workspace web build')
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/mcp') || root === undefined) {
      return reply.status(404).send({ error: 'not_found', message: 'Route not found' })
    }
    return reply.sendFile('index.html')
  })
}
