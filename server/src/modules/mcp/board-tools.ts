import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { AppError, ConflictError } from '../../shared/errors.js'
import {
  LIMITS,
  type ApprovalOption,
  type BatchQuestion,
  type Finding,
  type MigrationSiblings,
} from '../approvals/approval-rules.js'
import { questionOf } from '../approvals/help-rules.js'
import { HelpService } from '../approvals/help.service.js'
import type { Bus } from '../../shared/bus.js'
import { readMigrationSiblings } from '../projects/migration-siblings.js'
import { openApproval } from '../approvals/approval.service.js'
import { lintReply } from '../specs/spec-lint-text.js'
import { parseSpec } from '../specs/spec-parser.js'
import { SpecRepository } from '../specs/spec.repository.js'
import { acceptedPlanOf, planAnswers } from '../tasks/plan-history.js'
import { loadPlanHistory } from '../tasks/plan-history.queries.js'
import { checkSuggestion, suggestionRefusal } from './title-rules.js'
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
  /** Set for a helper's token: it reaches the helper's tools and no others. */
  helpId?: string | null
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
    .where('name', '!=', 'help')
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
      ...findings.map(
        (f) =>
          `- ${f.field}: ${f.code.replaceAll('_', ' ')}${f.after === undefined ? '' : `; migrations apply in name order, so a new name must sort after ${f.after}`}${f.code === 'fenced' ? '; send the raw file in context_md, without a Markdown code fence' : ''}`,
      ),
    ].join('\n'),
    true,
  )
}

/** The siblings of the migration a request names; undefined for any other request. */
async function siblingsOf(
  ctx: ToolContext,
  kind: string | undefined,
  files: string[] | undefined,
): Promise<MigrationSiblings | undefined> {
  const path = files?.[0]
  if (kind !== 'migration' || files?.length !== 1 || path === undefined) return undefined
  const where = await ctx.db
    .selectFrom('runs')
    .innerJoin('tasks', 'tasks.id', 'runs.task_id')
    .innerJoin('projects', 'projects.id', 'tasks.project_id')
    .select(['runs.worktree_path', 'projects.repo_path', 'projects.base_branch'])
    .where('runs.id', '=', ctx.runId)
    .executeTakeFirst()
  if (where === undefined || path.split(/[\\/]/).includes('..')) return undefined
  return readMigrationSiblings(
    { worktreePath: where.worktree_path, repoPath: where.repo_path, baseBranch: where.base_branch },
    path,
  )
}

/** The question a help is for, and the phase that asked it. */
async function helpQuestion(ctx: ToolContext, helpId: string) {
  const row = await ctx.db
    .selectFrom('helps')
    .innerJoin('approval_requests', 'approval_requests.id', 'helps.approval_id')
    .select([
      'helps.question_index',
      'approval_requests.kind',
      'approval_requests.question',
      'approval_requests.context_md',
      'approval_requests.options',
      'approval_requests.recommendation',
      'approval_requests.files',
      'approval_requests.questions',
      'approval_requests.phase_id',
    ])
    .where('helps.id', '=', helpId)
    .executeTakeFirstOrThrow()
  const asked = questionOf(
    {
      kind: row.kind,
      question: row.question,
      context_md: row.context_md,
      options: row.options as ApprovalOption[],
      recommendation: row.recommendation,
      questions: (row.questions ?? null) as BatchQuestion[] | null,
    },
    row.question_index,
  )
  return { row, asked }
}

/** The tools of a helper: it reads the task, its question and the asking phase, and saves. */
function registerHelpTools(server: McpServer, ctx: ToolContext, helpId: string): void {
  const service = new HelpService(ctx.db, undefined as unknown as Bus, ctx.clock)
  server.registerTool(
    'get_question',
    {
      description:
        'Read the question you were asked to help with: the question, its context, its options with the recommendation, and for a request to change files the files, for a migration request the path and the whole file, and for a plan the plan.',
    },
    async () => {
      const { row, asked } = await helpQuestion(ctx, helpId)
      if (asked === null) return reply('This question is gone.', true)
      const files = (row.files ?? null) as string[] | null
      return json({
        kind: row.kind,
        question: asked.question,
        context_md: asked.context_md,
        options: asked.options,
        recommendation: asked.recommendation,
        ...(files === null ? {} : { files }),
        ...(row.kind === 'plan' ? { plan: row.context_md } : {}),
        ...(row.kind === 'questions' ? { batch_lead: row.question } : {}),
      })
    },
  )

  server.registerTool(
    'get_phase_record',
    {
      description:
        'Read what the asking phase did, in order: its log_step lines and its tool calls.',
    },
    async () => {
      const { row } = await helpQuestion(ctx, helpId)
      if (row.phase_id === null) return json([])
      const events = await ctx.db
        .selectFrom('events')
        .select(['type', 'ts', 'tool', 'target', 'status', 'payload'])
        .where('run_id', '=', ctx.runId)
        .where('phase_id', '=', row.phase_id)
        .where('type', 'in', ['message', 'tool_call'])
        .orderBy('ts')
        .orderBy('id')
        .limit(300)
        .execute()
      return json(
        events
          .filter((e) => e.type === 'tool_call' || e.payload.declared === true)
          .map((e) =>
            e.type === 'tool_call'
              ? { type: 'tool_call', ts: e.ts, tool: e.tool, target: e.target, status: e.status }
              : { type: 'log_step', ts: e.ts, summary: e.payload.summary ?? null },
          ),
      )
    },
  )

  server.registerTool(
    'save_help_result',
    {
      description:
        'Save your result. A suggestion: option_id (one the question offers), text, or both, with reasoning and unsure (what you are unsure of). An explanation: asked (what is being asked), matters (why it matters to the task) and leads_to (what each option, or an answer in words, would lead to), and no option. Refused with the field to fix when it does not fit; fix it and save again.',
      inputSchema: {
        option_id: z.string().optional(),
        text: z.string().optional(),
        reasoning: z.string().optional(),
        unsure: z.string().optional(),
        asked: z.string().optional(),
        matters: z.string().optional(),
        leads_to: z.string().optional(),
      },
    },
    async (input) => {
      const saved = await service.save(helpId, input)
      return 'error' in saved ? reply(saved.error, true) : reply('Saved. End your turn now.')
    },
  )
}

export function registerBoardTools(server: McpServer, ctx: ToolContext): void {
  if (ctx.helpId != null) {
    registerHelpTools(server, ctx, ctx.helpId)
    registerReadTools(server, ctx)
    return
  }
  registerReadTools(server, ctx)
  registerRunTools(server, ctx)
}

function registerRunTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'request_approval',
    {
      description:
        'Ask the owner what you cannot settle yourself — an ambiguity, two approaches with real trade-offs, low confidence. One question: `question` with up to five options, the one you recommend, and the context the owner needs. Several: kind questions, with each in `questions` (up to eight), asked together and answered together. With kind out_of_plan, ask permission to change files the plan does not list. With kind migration, ask to create or change one migration: its path in `files`, a summary in `question`, the whole file in `context_md`, as the raw file exactly as it will be written, without a Markdown code fence. Before asking, format the file as the project’s formatter would, for example with `npx prettier --stdin-filepath <path>` where the project uses prettier, and send that output. Once the migration is allowed, write that text with a single Write; any other content, or an Edit, is refused. The run pauses: end your turn when this answers, and the owner’s answer arrives as your next message.',
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
      // Read before the transaction: no git call runs while rows are locked.
      const migrationSiblings = await siblingsOf(ctx, input.kind, input.files)
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
              ...(migrationSiblings === undefined ? {} : { migrationSiblings }),
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
        'Save the plan for this run. Every step names the requirements it serves and the files it touches; every criterion that is not withdrawn gets a check. A correction in the owner’s plan-gate answers that withdraws or changes one of the approved spec’s criteria goes into `withdrawn`, as { criterion, answer }, and not only into prose. A changed criterion counts as withdrawn. `answer` quotes the owner’s words, whole or as an excerpt, and the plan is refused otherwise. A withdrawn criterion has no row in the checks table. A plan with any withdrawal never has confidence high, because the withdrawal takes effect only once the owner approves the plan at the plan gate. Refused, with the reasons, when it does not map onto the spec. The rendered plan is limited to 20,000 characters; a longer plan is refused and must be shortened.',
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
        withdrawn: z
          .array(z.object({ criterion: z.string(), answer: z.string().min(1) }))
          .optional(),
      },
    },
    async (input) => {
      const plan: PlanInput = { ...(input as PlanInput), withdrawn: input.withdrawn ?? [] }
      const spec = await frozenSpec(ctx)
      const { approvals } = await loadPlanHistory(ctx.db, ctx.taskId)
      const answers = planAnswers(approvals, spec.version).map((a) => a.text)
      const findings = checkPlan(plan, spec, answers)
      if (findings.length > 0) return reply(findingsText('The plan was not saved:', findings), true)
      const body = renderPlan(plan)
      if (body.length > LIMITS.planContext)
        return reply(
          `The plan was not saved: its rendered text is ${body.length} characters, and the limit is ${LIMITS.planContext}. Shorten the plan and save it again.`,
          true,
        )
      return (await attach(ctx, 'plan', body, plan)) ?? reply('Plan saved.')
    },
  )

  server.registerTool(
    'save_report',
    {
      description:
        'Save the verify report: a verdict, with evidence, on every acceptance criterion. A criterion the spec marks as an owner check (owner in its parentheses) gets fail when you can see the work is wrong, and otherwise owner, with evidence of what you did check; it never gets pass. An owner verdict sends the criterion to the owner at the pull request, not back to Build. Every other criterion gets pass or fail, never owner. You judge by the spec, the plan’s `Withdrawn by the owner` list, the owner’s plan-gate answers, the diff and the test output. A criterion the plan lists as withdrawn gets withdrawn, with evidence naming the owner’s answer it rests on. No other criterion gets withdrawn. A withdrawn criterion never goes back to Build.',
      inputSchema: {
        summary: z.string().min(1).max(4000),
        criteria: z
          .array(
            z.object({
              id: z.string(),
              status: z.enum(['pass', 'fail', 'owner', 'withdrawn']),
              evidence: z.string().min(1),
            }),
          )
          .min(1),
      },
    },
    async (input) => {
      const { plans, approvals } = await loadPlanHistory(ctx.db, ctx.taskId)
      const entries = acceptedPlanOf(plans, approvals, ctx.runId)?.withdrawn ?? []
      const findings = checkReport(
        input as ReportInput,
        (await frozenSpec(ctx)).criteria,
        new Set(entries.map((e) => e.criterion)),
      )
      if (findings.length > 0)
        return reply(findingsText('The report was not saved:', findings), true)
      // The server writes the withdrawn list, from the accepted plan; the agent cannot supply it.
      const report: ReportInput = {
        ...(input as ReportInput),
        withdrawn: input.criteria.flatMap((c) => {
          const entry =
            c.status === 'withdrawn' ? entries.find((e) => e.criterion === c.id) : undefined
          return entry === undefined ? [] : [{ criterion: c.id, answer: entry.answer }]
        }),
      }
      return (
        (await attach(ctx, 'verify_report', renderReport(report), report)) ?? reply('Report saved.')
      )
    },
  )

  server.registerTool(
    'suggest_title',
    {
      description:
        'Suggest a clearer title for the task: one line of at most 200 characters, naming what the task affects in the code’s own terms, and a reason of one line, at most 300 characters, saying which code the title names. Every call of this run rewrites its one suggestion. The title is not applied: the owner accepts, edits or discards it.',
      inputSchema: { title: z.string(), reason: z.string() },
    },
    async (input) => {
      if ((await runKind(ctx)) !== 'title')
        return reply('suggest_title belongs to a title run; this run is not one.', true)
      const phase = await runningPhase(ctx)
      if (phase === undefined)
        return reply('No phase of this run is running; nothing was stored.', true)
      const findings = checkSuggestion(input)
      if (findings.length > 0) return reply(suggestionRefusal(findings), true)
      const data = JSON.stringify({ title: input.title, reason: input.reason, decision: null })
      const stored = await ctx.db
        .updateTable('artifacts')
        .set({ body_md: input.title, data, phase_id: phase.id })
        .where('run_id', '=', ctx.runId)
        .where('kind', '=', 'title')
        .returning('id')
        .executeTakeFirst()
      if (stored === undefined)
        await ctx.db
          .insertInto('artifacts')
          .values({
            run_id: ctx.runId,
            phase_id: phase.id,
            kind: 'title',
            body_md: input.title,
            uri: null,
            data,
          })
          .execute()
      await publish(ctx.db, { topic: 'run.event', runId: ctx.runId, taskId: ctx.taskId })
      return reply(`Suggested: ${input.title}`)
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

function registerReadTools(server: McpServer, ctx: ToolContext): void {
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
}
