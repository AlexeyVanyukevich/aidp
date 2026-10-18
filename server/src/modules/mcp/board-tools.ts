import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { parseSpec } from '../specs/spec-parser.js'
import {
  checkPlan,
  checkReport,
  renderPlan,
  renderReport,
  type PlanInput,
  type ReportInput,
} from './plan-check.js'

export interface ToolContext {
  db: Kysely<Database>
  runId: string
  taskId: string
  clock: () => Date
}

const reply = (text: string, isError = false) => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError } : {}),
})
const json = (value: unknown) => reply(JSON.stringify(value, null, 2))

async function runningPhase(ctx: ToolContext) {
  return ctx.db
    .selectFrom('phases')
    .select(['id', 'agent', 'name'])
    .where('run_id', '=', ctx.runId)
    .where('status', '=', 'running')
    .orderBy('started_at', 'desc')
    .executeTakeFirst()
}

async function frozenSpec(ctx: ToolContext) {
  const row = await ctx.db
    .selectFrom('runs')
    .innerJoin('specs', (join) =>
      join
        .onRef('specs.task_id', '=', 'runs.task_id')
        .onRef('specs.version', '=', 'runs.spec_version'),
    )
    .select(['specs.version', 'specs.body_md', 'specs.criteria'])
    .where('runs.id', '=', ctx.runId)
    .executeTakeFirstOrThrow()
  return {
    version: row.version,
    body_md: row.body_md,
    requirements: parseSpec(row.body_md).requirements.map((r) => r.id),
    criteria: row.criteria ?? [],
  }
}

async function attach(
  ctx: ToolContext,
  kind: 'plan' | 'verify_report',
  body: string,
  data: unknown,
) {
  const phase = await runningPhase(ctx)
  if (phase === undefined) return reply('No phase of this run is running; nothing was saved.', true)
  await ctx.db
    .insertInto('artifacts')
    .values({
      run_id: ctx.runId,
      phase_id: phase.id,
      kind,
      body_md: body,
      uri: null,
      data: JSON.stringify(data),
    })
    .execute()
  await publish(ctx.db, { topic: 'run.event', runId: ctx.runId, taskId: ctx.taskId })
  return undefined
}

const findingsText = (title: string, findings: { code: string; id: string; step?: number }[]) =>
  [
    title,
    ...findings.map((f) => `- ${f.code} ${f.id}${f.step === undefined ? '' : ` (step ${f.step})`}`),
  ].join('\n')

export function registerBoardTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_task',
    { description: 'Read the task this run carries out.' },
    async () => {
      const row = await ctx.db
        .selectFrom('tasks')
        .innerJoin('projects', 'projects.id', 'tasks.project_id')
        .select(['tasks.number', 'tasks.title', 'tasks.description_md', 'projects.key'])
        .where('tasks.id', '=', ctx.taskId)
        .executeTakeFirstOrThrow()
      const phase = await runningPhase(ctx)
      return json({
        key: `${row.key}-${row.number}`,
        title: row.title,
        description_md: row.description_md,
        run_id: ctx.runId,
        phase: phase?.name ?? null,
      })
    },
  )

  server.registerTool(
    'get_spec',
    { description: 'Read the approved, frozen spec this run must satisfy.' },
    async () => json(await frozenSpec(ctx)),
  )

  server.registerTool(
    'save_plan',
    {
      description:
        'Save the plan for this run. Every step names the requirements it serves and the files it touches; every acceptance criterion gets a check. Refused, with the reasons, when it does not map onto the spec.',
      inputSchema: {
        summary: z.string().min(1).max(4000),
        confidence: z.enum(['high', 'medium', 'low']),
        steps: z
          .array(
            z.object({
              title: z.string().min(1),
              requirements: z.array(z.string()).min(1),
              files: z.array(z.string()),
              estimate_usd: z.number().nonnegative().optional(),
            }),
          )
          .min(1)
          .max(50),
        // No minimum: an empty list reaches checkPlan, which names each criterion left unchecked.
        checks: z.array(z.object({ criterion: z.string(), how: z.string().min(1) })),
      },
    },
    async (input) => {
      const plan = input as PlanInput
      const findings = checkPlan(plan, await frozenSpec(ctx))
      if (findings.length > 0) return reply(findingsText('The plan was not saved:', findings), true)
      return (await attach(ctx, 'plan', renderPlan(plan), plan)) ?? reply('Plan saved.')
    },
  )

  server.registerTool(
    'save_report',
    {
      description:
        'Save the verify report: a pass or fail verdict, with evidence, on every acceptance criterion.',
      inputSchema: {
        summary: z.string().min(1).max(4000),
        criteria: z
          .array(
            z.object({
              id: z.string(),
              status: z.enum(['pass', 'fail']),
              evidence: z.string().min(1),
            }),
          )
          .min(1),
      },
    },
    async (input) => {
      const report = input as ReportInput
      const findings = checkReport(report, (await frozenSpec(ctx)).criteria)
      if (findings.length > 0)
        return reply(findingsText('The report was not saved:', findings), true)
      return (
        (await attach(ctx, 'verify_report', renderReport(report), report)) ?? reply('Report saved.')
      )
    },
  )

  server.registerTool(
    'log_step',
    {
      description: 'Record a step you took, in one line, with your confidence in it.',
      inputSchema: {
        summary: z.string().min(1).max(2000),
        confidence: z.enum(['high', 'medium', 'low']).optional(),
      },
    },
    async (input) => {
      const phase = await runningPhase(ctx)
      await ctx.db
        .insertInto('events')
        .values({
          id: crypto.randomUUID(),
          run_id: ctx.runId,
          phase_id: phase?.id ?? null,
          ts: ctx.clock(),
          type: 'message',
          agent: phase?.agent ?? null,
          model: null,
          tool: null,
          target: null,
          status: null,
          duration_ms: null,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          payload: JSON.stringify({
            declared: true,
            summary: input.summary,
            ...(input.confidence ? { confidence: input.confidence } : {}),
          }),
        })
        .execute()
      await publish(ctx.db, { topic: 'run.event', runId: ctx.runId, taskId: ctx.taskId })
      return reply('Logged.')
    },
  )
}
