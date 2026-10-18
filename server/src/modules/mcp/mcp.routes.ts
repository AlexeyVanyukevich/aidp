import type { FastifyInstance } from 'fastify'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { resolveRunToken } from '../../shared/tokens.js'
import { registerBoardTools } from './board-tools.js'

/**
 * Stateless: a server and a transport per request, bound to the run the token names. Nothing
 * survives between calls, so a restarted server serves a running agent without it noticing.
 */
export function registerMcp(app: FastifyInstance): void {
  app.post('/mcp', async (request, reply) => {
    const context = await resolveRunToken(app.db, request.headers.authorization, app.clock())
    const server = new McpServer({ name: 'board', version: '1.0.0' })
    registerBoardTools(server, { db: app.db, clock: app.clock, ...context })
    // No sessionIdGenerator: the SDK reads its absence as stateless.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    reply.hijack()
    reply.raw.on('close', () => {
      void transport.close()
      void server.close()
    })
    // The SDK's transport classes declare their optional handlers without `| undefined`, which
    // `exactOptionalPropertyTypes` will not match to its own Transport interface.
    await server.connect(transport as Transport)
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })

  // A stateless server keeps no stream to resume and no session to end.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      handler: async (_request, reply) =>
        reply
          .status(405)
          .send({ error: 'bad_request', message: 'This MCP server is stateless; use POST' }),
    })
  }
}
