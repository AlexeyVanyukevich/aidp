// A stand-in for the board's MCP server, over stdio, for recording streams with the real
// claude CLI. `request_approval` answers exactly as the board's does (slice 2 spec, §5), for one
// question or a batch (slice 3 spec, §6); `save_spec` as a clean save does (§7); `note` gives a
// recording tool calls that cost nothing to answer.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const option = z.object({ id: z.string(), label: z.string(), impact: z.string().optional() })
const server = new McpServer({ name: 'board', version: '0.0.0' })
server.registerTool(
  'request_approval',
  {
    description:
      'Ask the owner a question you cannot settle yourself, or with kind "questions" several at once, each with up to five options and the one you recommend. The run pauses until they answer.',
    inputSchema: {
      kind: z.enum(['question', 'questions']).optional(),
      question: z.string().optional(),
      options: z.array(z.union([z.string(), option])).optional(),
      questions: z
        .array(
          z.object({
            question: z.string(),
            options: z.array(option).optional(),
            recommendation: z.string().optional(),
            context_md: z.string().optional(),
          }),
        )
        .optional(),
      context_md: z.string().optional(),
    },
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
  'save_spec',
  {
    description:
      'Save the spec as Markdown. Answers with its lint: fix what it names and save again.',
    inputSchema: { body_md: z.string() },
  },
  async () => ({ content: [{ type: 'text', text: 'Saved v1. Lint: clean.' }] }),
)
server.registerTool(
  'note',
  { description: 'Record a short note.', inputSchema: { text: z.string() } },
  async () => ({ content: [{ type: 'text', text: 'Noted.' }] }),
)
await server.connect(new StdioServerTransport())
