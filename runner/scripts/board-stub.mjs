// A stand-in for the board's MCP server, over stdio, for recording streams with the real
// claude CLI. `request_approval` answers exactly as the board's does (slice 2 spec, §5); `note`
// gives a recording tool calls that cost nothing to answer.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'board', version: '0.0.0' })
server.registerTool(
  'request_approval',
  {
    description:
      'Ask the owner a question you cannot settle yourself. The run pauses until they answer.',
    inputSchema: { question: z.string(), options: z.array(z.string()) },
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: 'Paused: the owner will answer on the board, and the answer will arrive as your next message. End your turn now.',
      },
    ],
  }),
)
server.registerTool(
  'note',
  { description: 'Record a short note.', inputSchema: { text: z.string() } },
  async () => ({ content: [{ type: 'text', text: 'Noted.' }] }),
)
await server.connect(new StdioServerTransport())
