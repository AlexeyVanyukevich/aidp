import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { AppError, ConflictError } from '../../shared/errors.js'
import type { Finding } from '../approvals/approval-rules.js'
import { openApproval } from '../approvals/approval.service.js'
import { lintReply } from '../specs/spec-lint-text.js'
import { parseSpec } from '../specs/spec-parser.js'
import { SpecRepository } from '../specs/spec.repository.js'
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

const OPTION = z.object({ id: z.string(), label: z.string(), impact: z.string().optional() })
/** An option as the rules hold it: an absent impact left out, not undefined. */
const option = ({ id, label, impact }: z.infer<typeof OPTION>) => ({
  id,
  label,
  ...(impact === undefined ? {} : { impact }),
})

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

async function runKind(ctx: ToolContext) {
  const run = await ctx.db
    .selectFrom('runs')
    .select('kind')
    .where('id', '=', ctx.runId)
    .executeTakeFirstOrThrow()
  return run.kind
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

/** What the agent reads once its question is on the board (spec §5). */
export const PAUSED_REPLY =
  'Paused: the owner will answer on the board, and the answer will arrive as your next message. End your turn now.'

/** Why a question was not asked, worded for the agent that asked it. */
function refusal(error: unknown) {
  if (!(error instanceof AppError)) throw error
  const reason = error.details?.reason
  if (reason === 'waiting')
    return reply('This run is already waiting for an answer. End your turn now.', true)
  if (reason === 'no_phase')
    return reply('No phase of this run is running; nothing was asked.', true)
  const findings = (error.details?.findings ?? []) as Finding[]
  return reply(
    [
      'The question was not asked:',
      ...findings.map((f) => `- ${f.field}: ${f.code.replaceAll('_', ' ')}`),
    ].join('\n'),
    true,
  )
}

export function registerBoardTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'request_approval',
    {
      description:
        'Ask the owner what you cannot settle yourself — an ambiguity, two approaches with real trade-offs, low confidence. One question: `question` with up to five options, the one you recommend, and the context the owner needs. Several: kind questions, with each in `questions` (up to eight), asked together and answered together. With kind out_of_plan, ask permission to change files the plan does not list. With kind migration, ask to create or change one migration: its path in `files`, a summary in `question`, the whole file in `context_md`. The run pauses: end your turn when this answers, and the owner’s answer arrives as your next message.',
      inputSchema: {
        kind: z.enum(['question', 'out_of_plan', 'migration', 'questions']).optional(),
        question: z.string().optional(),
        options: z.array(OPTION).optional(),
        recommendation: z.string().optional(),
        context_md: z.string().optional(),
        files: z.array(z.string()).optional(),
        questions: z
          .array(
            z.object({
              question: z.string(),
              options: z.array(OPTION).optional(),
              recommendation: z.string().optional(),
              context_md: z.string().optional(),
            }),
          )
          .optional(),
      },
    },
    async (input) => {
      const phase = await runningPhase(ctx)
      if (phase === undefined) {
        // Asking again after the first question paused the phase: the useful answer is to stop.
        const waiting = await ctx.db
          .selectFrom('approval_requests')
          .select('id')
          .where('run_id', '=', ctx.runId)
          .where('status', '=', 'open')
          .executeTakeFirst()
        return refusal(
          new ConflictError('', { reason: waiting === undefined ? 'no_phase' : 'waiting' }),
        )
      }
      try {
        await ctx.db.transaction().execute((trx) =>
          openApproval(
            trx,
            {
              runId: ctx.runId,
              taskId: ctx.taskId,
              phaseId: phase.id,
              kind: input.kind ?? 'question',
              question: input.question ?? '',
              options: (input.options ?? []).map(option),
              recommendation: input.recommendation ?? null,
              context_md: input.context_md ?? null,
              files: input.files ?? null,
              questions: (input.questions ?? []).map((asked) => ({
                question: asked.question,
                options: (asked.options ?? []).map(option),
                recommendation: asked.recommendation ?? null,
                context_md: asked.context_md ?? null,
              })),
            },
            ctx.clock(),
            { recordEvent: true },
          ),
        )
      } catch (error) {
        return refusal(error)
      }
      return reply(PAUSED_REPLY)
    },
  )

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
    {
      description:
        'Read the spec: in a delivery run, the approved, frozen spec it must satisfy; in a spec run, the task’s latest version, which a redraft starts from.',
    },
    async () => {
      if ((await runKind(ctx)) === 'delivery') return json(await frozenSpec(ctx))
      const latest = await ctx.db
        .selectFrom('specs')
        .select(['version', 'body_md'])
        .where('task_id', '=', ctx.taskId)
        .orderBy('version', 'desc')
        .executeTakeFirst()
      return latest === undefined ? reply('This task has no spec yet.') : json(latest)
    },
  )

  server.registerTool(
    'save_spec',
    {
      description:
        'Save the spec, as Markdown in the Spec tab’s template. Every save of this run rewrites its one version. Answers with the lint: fix what it names and save again.',
      inputSchema: { body_md: z.string().max(50_000) },
    },
    async (input) => {
      if ((await runKind(ctx)) !== 'spec')
        return reply('save_spec belongs to a spec run; this run delivers an approved spec.', true)
      const phase = await runningPhase(ctx)
      if (phase === undefined)
        return reply('No phase of this run is running; nothing was saved.', true)
      const saved = await ctx.db
        .transaction()
        .execute((trx) =>
          new SpecRepository(ctx.db).saveForRun(trx, ctx.taskId, ctx.runId, input.body_md),
        )
      await publish(ctx.db, { topic: 'run.event', runId: ctx.runId, taskId: ctx.taskId })
      return reply(lintReply(saved.version, parseSpec(input.body_md)))
    },
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
