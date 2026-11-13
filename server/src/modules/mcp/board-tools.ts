import { sql, type Kysely } from 'kysely'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { AppError, ConflictError } from '../../shared/errors.js'
import type { HelpSubject } from '../../shared/vocabulary.js'
import {
  LIMITS,
  type ApprovalOption,
  type BatchQuestion,
  type Finding,
  type MigrationSiblings,
} from '../approvals/approval-rules.js'
import { questionOf } from '../approvals/help-rules.js'
import {
  recommendableActions,
  specRead,
  stoppedRunActions,
  type CardDecision,
} from '../approvals/decision-rules.js'
import { HelpService, readSubjectFacts } from '../approvals/help.service.js'
import type { Bus } from '../../shared/bus.js'
import { readMigrationSiblings } from '../projects/migration-siblings.js'
import { openApproval } from '../approvals/approval.service.js'
import { lintReply, lintText } from '../specs/spec-lint-text.js'
import { parseSpec } from '../specs/spec-parser.js'
import { SpecRepository } from '../specs/spec.repository.js'
import { acceptedPlanOf, planAnswers } from '../tasks/plan-history.js'
import { loadPlanHistory, planToKeepFor } from '../tasks/plan-history.queries.js'
import { foldKey, filterPattern, parseTaskKey } from './board-read.js'
import { proposalsOf } from '../proposals/proposal.repository.js'
import { ProposalRefused, ProposalService } from '../proposals/proposal.service.js'
import {
  BEARING_LIMIT,
  WORKAROUND_LIMIT,
  checkTitle,
  labelsError,
  missingLabels,
} from '../proposals/proposal.rules.js'
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

/** How many of a phase's newest entries a stopped-run help reads. */
const PHASE_RECORD_LIMIT = 300

interface HelpHead {
  decision: CardDecision | 'question'
  mode: string
  subject: HelpSubject | null
  status: string
}

async function helpHead(ctx: ToolContext, helpId: string): Promise<HelpHead> {
  const row = await ctx.db
    .selectFrom('helps')
    .select(['decision', 'mode', 'subject', 'status'])
    .where('id', '=', helpId)
    .executeTakeFirstOrThrow()
  return row as HelpHead
}

/** A stopped run's latest non-help phase: its newest entries, and how many earlier were left out. */
async function stoppedPhaseRecord(ctx: ToolContext, runId: string, phaseId?: string) {
  const phase = await ctx.db
    .selectFrom('phases')
    .select('id')
    .where('run_id', '=', runId)
    .where('name', '!=', 'help')
    .$if(phaseId !== undefined, (qb) => qb.where('id', '=', phaseId ?? ''))
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (phase === undefined) return { entries: [], earlier_left_out: 0 }
  const entriesOf = () =>
    ctx.db
      .selectFrom('events')
      .where('run_id', '=', runId)
      .where('phase_id', '=', phase.id)
      .where((eb) =>
        eb.or([
          eb('type', '=', 'tool_call'),
          eb.and([eb('type', '=', 'message'), eb(sql`payload->>'declared'`, '=', 'true')]),
        ]),
      )
  const total = await entriesOf()
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow()
  const newest = await entriesOf()
    .select(['type', 'ts', 'tool', 'target', 'status', 'payload'])
    .orderBy('ts', 'desc')
    .orderBy('id', 'desc')
    .limit(PHASE_RECORD_LIMIT)
    .execute()
  return {
    entries: newest
      .reverse()
      .map((e) =>
        e.type === 'tool_call'
          ? { type: 'tool_call', ts: e.ts, tool: e.tool, target: e.target, status: e.status }
          : { type: 'log_step', ts: e.ts, summary: e.payload.summary ?? null },
      ),
    earlier_left_out: Math.max(0, Number(total.n) - PHASE_RECORD_LIMIT),
  }
}

async function latestReport(ctx: ToolContext, runId: string) {
  const report = await ctx.db
    .selectFrom('artifacts')
    .select(['body_md', 'data'])
    .where('run_id', '=', runId)
    .where('kind', '=', 'verify_report')
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return report === undefined ? null : { body_md: report.body_md, data: report.data }
}

/** What `get_decision` returns (R11). */
async function decisionRecord(ctx: ToolContext, helpId: string, head: HelpHead) {
  const task = await ctx.db
    .selectFrom('tasks')
    .innerJoin('projects', 'projects.id', 'tasks.project_id')
    .select(['tasks.number', 'tasks.title', 'tasks.description_md', 'projects.key'])
    .where('tasks.id', '=', ctx.taskId)
    .executeTakeFirstOrThrow()
  const facts = await readSubjectFacts(ctx.db, ctx.taskId)
  const common = {
    decision: head.decision,
    mode: head.mode,
    subject: head.subject,
    task: {
      key: `${task.key}-${task.number}`,
      title: task.title,
      description_md: task.description_md,
    },
  }
  const subject = head.subject
  if (head.decision === 'spec_review' && subject !== null && 'spec_version' in subject) {
    const spec = await ctx.db
      .selectFrom('specs')
      .select(['version', 'body_md'])
      .where('task_id', '=', ctx.taskId)
      .where('version', '=', subject.spec_version)
      .executeTakeFirst()
    const parsed = spec === undefined ? null : parseSpec(spec.body_md)
    return {
      ...common,
      spec: spec ?? null,
      lint:
        parsed === null
          ? null
          : {
              approvable: parsed.approvable,
              findings: parsed.findings.map(lintText),
              open_questions: parsed.openQuestions,
            },
    }
  }
  if (head.decision === 'stopped_run' && subject !== null && 'run_id' in subject) {
    const run = await ctx.db
      .selectFrom('runs')
      .select(['id', 'kind', 'number', 'block', 'failure_reason', 'checkpoint'])
      .where('id', '=', subject.run_id)
      .executeTakeFirstOrThrow()
    const phases = await ctx.db
      .selectFrom('phases')
      .select(['name', 'attempt', 'status', 'summary_md'])
      .where('run_id', '=', run.id)
      .where('name', '!=', 'help')
      .orderBy('started_at')
      .execute()
    const actions = stoppedRunActions(facts)
    const kept = actions.includes('rerun_keep')
      ? await planToKeepFor(ctx.db, ctx.taskId)
      : undefined
    const plan =
      kept === undefined
        ? null
        : await ctx.db
            .selectFrom('artifacts')
            .select('body_md')
            .where('id', '=', kept.id)
            .executeTakeFirstOrThrow()
    const resumable = run.checkpoint !== null
    return {
      ...common,
      run: { kind: run.kind, number: run.number },
      block: run.block,
      failure_reason: run.failure_reason,
      checkpoint:
        run.checkpoint === null
          ? null
          : { stage: run.checkpoint.stage, attempt: run.checkpoint.attempt },
      phases,
      verify_report: await latestReport(ctx, run.id),
      actions,
      recommendable_actions: recommendableActions(facts),
      ...(kept === undefined || plan === null
        ? {}
        : { plan_to_keep: { run_number: kept.runNumber, body_md: plan.body_md } }),
      resumable,
      ...(resumable
        ? {}
        : {
            not_resumable:
              'Resume would answer 409 no_checkpoint: this run left no checkpoint to resume from.',
          }),
    }
  }
  if (head.decision === 'proposal' && subject !== null && 'proposal_id' in subject) {
    const proposal = (await proposalsOf(ctx.db, ctx.taskId)).find(
      (view) => view.id === subject.proposal_id,
    )
    return {
      ...common,
      proposal: proposal ?? null,
      run: proposal?.run ?? null,
      phase: proposal?.phase ?? null,
      offered: proposal?.offered ?? [],
    }
  }
  if (head.decision === 'pull_request' && subject !== null && 'pr_run_id' in subject) {
    const run = await ctx.db
      .selectFrom('runs')
      .select(['id', 'number', 'branch', 'pr_number', 'pr_url', 'spec_version'])
      .where('id', '=', subject.pr_run_id)
      .executeTakeFirstOrThrow()
    const spec =
      run.spec_version === null
        ? null
        : ((await ctx.db
            .selectFrom('specs')
            .select(['version', 'body_md'])
            .where('task_id', '=', ctx.taskId)
            .where('version', '=', run.spec_version)
            .executeTakeFirst()) ?? null)
    const { plans, approvals } = await loadPlanHistory(ctx.db, ctx.taskId)
    const plan = acceptedPlanOf(plans, approvals, run.id)
    return {
      ...common,
      run: {
        number: run.number,
        branch: run.branch ?? `board/${common.task.key}-r${run.number}`,
        pull_request: { number: run.pr_number, url: run.pr_url },
      },
      spec,
      plan: plan === undefined ? null : plan.bodyMd,
      verify_report: await latestReport(ctx, run.id),
    }
  }
  const read = specRead(facts)
  const spec =
    read.version === null
      ? null
      : await ctx.db
          .selectFrom('specs')
          .select(['version', 'body_md'])
          .where('task_id', '=', ctx.taskId)
          .where('version', '=', read.version)
          .executeTakeFirst()
  const runs = await ctx.db
    .selectFrom('runs')
    .select(['id', 'number', 'status', 'branch', 'pr_number', 'pr_url', 'failure_reason'])
    .where('task_id', '=', ctx.taskId)
    .where('kind', '=', 'delivery')
    .orderBy('number')
    .execute()
  const delivery = await Promise.all(
    runs.map(async (run) => ({
      number: run.number,
      status: run.status,
      verify_report: await latestReport(ctx, run.id),
      pull_request:
        run.pr_number === null
          ? null
          : {
              number: run.pr_number,
              url: run.pr_url,
              state:
                run.id !== facts.latestDeliveryRunId ||
                run.failure_reason !== null ||
                facts.taskState === 'failed'
                  ? 'closed'
                  : facts.taskState === 'done'
                    ? 'merged'
                    : 'open',
            },
    })),
  )
  return {
    ...common,
    checked_against: read.checkedAgainst,
    spec: spec ?? null,
    delivery_runs: delivery,
    branch_produced: runs.some((run) => run.branch !== null),
  }
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
      if ((await helpHead(ctx, helpId)).decision !== 'question')
        return reply('This help is for a decision, not a question: use get_decision.', true)
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
      const head = await helpHead(ctx, helpId)
      if (head.decision === 'stopped_run' && head.subject !== null && 'run_id' in head.subject)
        return json(await stoppedPhaseRecord(ctx, head.subject.run_id))
      if (head.decision === 'proposal' && head.subject !== null && 'proposal_id' in head.subject) {
        const proposal = await ctx.db
          .selectFrom('proposals')
          .select(['run_id', 'phase_id'])
          .where('id', '=', head.subject.proposal_id)
          .executeTakeFirst()
        if (proposal === undefined) return json({ entries: [], earlier_left_out: 0 })
        return json(await stoppedPhaseRecord(ctx, proposal.run_id, proposal.phase_id))
      }
      if (head.decision !== 'question')
        return reply('This help has no phase record: use get_decision.', true)
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
    'get_decision',
    {
      description:
        'Read the decision you were asked to help with: the decision, the mode, what it is about, the task, and what the decision reads (the spec and its lint, or the stopped run and its actions, or the spec and the delivery runs).',
    },
    async () => {
      const head = await helpHead(ctx, helpId)
      if (head.decision === 'question')
        return reply('This help is for a question, not a decision: use get_question.', true)
      return json(await decisionRecord(ctx, helpId, head))
    },
  )

  server.registerTool(
    'save_help_result',
    {
      description:
        'Save your result. A suggestion: option_id (one the question offers), text, or both, with reasoning and unsure (what you are unsure of). An explanation: asked (what is being asked), matters (why it matters to the task) and leads_to (what each option, or an answer in words, would lead to), and no option. For a decision help the fields depend on the mode. review: verdict (changes or nothing_to_change), findings (kind, where, text; a finding may carry choices, 2 to 5 short ways to settle it, with recommended the index of the one you would choose) and unsure. restate: changes, requirements and left_out. recommend: why_stopped, action, reasoning and unsure. check: checked_against, produced, unfinished (where, text) and unsure. advise: variant (one the proposal offers now), reasoning and unsure. code_review: verdict (changes or nothing_to_change), findings (kind: bug, breaks, duplicate, fit or test; file; line, optional; text; matters) and unsure. Refused with the field to fix when it does not fit; fix it and save again.',
      inputSchema: {
        option_id: z.string().optional(),
        text: z.string().optional(),
        reasoning: z.string().optional(),
        unsure: z.string().optional(),
        asked: z.string().optional(),
        matters: z.string().optional(),
        leads_to: z.string().optional(),
        verdict: z.string().optional(),
        findings: z
          .array(
            z.object({
              kind: z.string(),
              where: z.string().optional(),
              text: z.string(),
              file: z.string().optional(),
              line: z.number().optional(),
              matters: z.string().optional(),
              choices: z.array(z.string()).optional(),
              recommended: z.number().optional(),
            }),
          )
          .optional(),
        changes: z.string().optional(),
        requirements: z.string().optional(),
        left_out: z.string().optional(),
        why_stopped: z.string().optional(),
        action: z.string().optional(),
        checked_against: z.string().optional(),
        variant: z.string().optional(),
        produced: z.string().optional(),
        unfinished: z
          .array(z.object({ where: z.string().optional(), text: z.string() }))
          .optional(),
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
  registerProposalTools(server, ctx)
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
    'save_suggestion',
    {
      description:
        'Save the suggested description for the task: the whole text, in Markdown, saying where you are unsure. Every call of this run rewrites its one suggestion. The description is not changed: the owner accepts, edits or discards the suggestion.',
      inputSchema: { body_md: z.string().min(1).max(100_000) },
    },
    async (input) => {
      if ((await runKind(ctx)) !== 'rephrase')
        return reply('save_suggestion belongs to a rephrase run; this run is not one.', true)
      if ((await runningPhase(ctx)) === undefined)
        return reply('No phase of this run is running; nothing was saved.', true)
      await ctx.db
        .updateTable('runs')
        .set({ suggestion_md: input.body_md })
        .where('id', '=', ctx.runId)
        .execute()
      await publish(ctx.db, { topic: 'run.event', runId: ctx.runId, taskId: ctx.taskId })
      return reply('Saved the suggestion.')
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
  registerBoardReadingTools(server, ctx)
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

/** The error reply for a project key that is not on the board: it lists the valid keys. */
async function unknownProject(ctx: ToolContext, key: string, subject = key) {
  const projects = await ctx.db.selectFrom('projects').select('key').orderBy('key').execute()
  return reply(
    `No project has the key ${key}${subject === key ? '' : `, so ${subject} does not exist`}. The valid project keys are: ${projects.map((p) => p.key).join(', ')}.`,
    true,
  )
}

const PROPOSING_PHASES = ['spec', 'plan', 'build', 'verify']

/** The projects a run may propose to: its task's own, and the ones that project links to. */
async function proposable(ctx: ToolContext) {
  const own = await ctx.db
    .selectFrom('tasks')
    .innerJoin('projects', 'projects.id', 'tasks.project_id')
    .select(['projects.id', 'projects.key'])
    .where('tasks.id', '=', ctx.taskId)
    .executeTakeFirstOrThrow()
  const linked = await ctx.db
    .selectFrom('project_links')
    .innerJoin('projects', 'projects.id', 'project_links.linked_project_id')
    .select(['projects.id', 'projects.key'])
    .where('project_links.project_id', '=', own.id)
    .execute()
  return [own, ...linked].sort((a, b) => (a.key < b.key ? -1 : 1))
}

const blankText = (text: string | undefined) => text === undefined || text.trim() === ''

function registerProposalTools(server: McpServer, ctx: ToolContext): void {
  const service = new ProposalService(ctx.db, ctx.clock)
  server.registerTool(
    'propose_task',
    {
      description:
        'Propose a task for a finding outside your task: a bug noticed on the way, a missing test, a document that has drifted. It never creates a task; the owner settles each proposal on the card, by filing it, filing it with your workaround, or dismissing it. `project` is the task’s own project or one in your linked projects. `description_md` has the labels **Where:**, **Found:**, **Problem:** and **Impact:**, each at the start of a line. `related` says whether the finding bears on this task. A related proposal needs `bearing_md` (how it bears on this task), may carry `workaround_md`, and pauses the run until the owner settles it; build and verify propose unrelated findings only. An unrelated one may carry `bearing_md` (why it came up here) and never `workaround_md`. Search with list_tasks and list_proposals first. A run makes at most 10 proposals.',
      inputSchema: {
        project: z.string(),
        title: z.string(),
        description_md: z.string(),
        related: z.boolean(),
        bearing_md: z.string().optional(),
        workaround_md: z.string().optional(),
      },
    },
    async (input) => {
      const phase = await runningPhase(ctx)
      if (phase === undefined) {
        const waiting = await ctx.db
          .selectFrom('approval_requests')
          .select('id')
          .where('run_id', '=', ctx.runId)
          .where('status', '=', 'open')
          .executeTakeFirst()
        return waiting === undefined
          ? reply('No phase of this run is running; nothing was saved.', true)
          : reply('This run is already waiting for an answer. End your turn now.', true)
      }
      const kind = await runKind(ctx)
      if (kind !== 'spec' && kind !== 'delivery')
        return reply(`A ${kind} run proposes no tasks; nothing was saved.`, true)
      if (!PROPOSING_PHASES.includes(phase.name))
        return reply(`The ${phase.name} phase proposes no tasks; nothing was saved.`, true)
      if (input.related && (phase.name === 'build' || phase.name === 'verify'))
        return reply(
          'related must be false in build and verify: every finding proposed there is unrelated, and a blocker of the task goes through request_approval.',
          true,
        )
      const bearing = input.bearing_md?.trim() ?? ''
      if (input.related && bearing === '')
        return reply(
          'bearing_md is required when related is true: say how it bears on this task.',
          true,
        )
      if (bearing.length > BEARING_LIMIT)
        return reply(
          `bearing_md is ${bearing.length} characters; the limit is ${BEARING_LIMIT}.`,
          true,
        )
      if (input.workaround_md !== undefined && !input.related)
        return reply(
          'workaround_md belongs to a related proposal; leave it out when related is false.',
          true,
        )
      const workaround = input.workaround_md?.trim()
      if (workaround !== undefined && (workaround === '' || workaround.length > WORKAROUND_LIMIT))
        return reply(`workaround_md must be 1–${WORKAROUND_LIMIT} characters after trimming.`, true)

      const titled = checkTitle(input.title)
      if ('error' in titled) return reply(titled.error, true)
      const missing = missingLabels(input.description_md)
      if (missing.length > 0) return reply(labelsError(missing), true)

      const allowed = await proposable(ctx)
      const key = foldKey(input.project)
      const target = allowed.find((project) => project.key === key)
      if (target === undefined)
        return reply(
          `${key} is not a project this task may propose to. Allowed: ${allowed.map((p) => p.key).join(', ')}.`,
          true,
        )
      try {
        const saved = await service.propose({
          runId: ctx.runId,
          taskId: ctx.taskId,
          phaseId: phase.id,
          agent: phase.agent,
          targetProjectId: target.id,
          title: titled.title,
          description_md: input.description_md,
          related: input.related,
          bearing_md: bearing === '' ? null : bearing,
          workaround_md: workaround ?? null,
        })
        if (saved.paused) return reply(PAUSED_REPLY)
        return reply(
          `Proposed. The owner settles it on the card; you do not wait. Go on with your task, and name the proposal "${titled.title}" in your summary or report.`,
        )
      } catch (error) {
        if (error instanceof ProposalRefused) return reply(error.message, true)
        return refusal(error)
      }
    },
  )

  server.registerTool(
    'list_proposals',
    {
      description:
        'List every proposal of this task’s spec and delivery runs, newest run first, then by number: title, target project, whether it is related, its outcome (null while open) and the task it filed.',
    },
    async () => json(await proposalsOf(ctx.db, ctx.taskId)),
  )
}

function registerBoardReadingTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_projects',
    {
      description: 'List every project on the board, ordered by key, each with its key and name.',
    },
    async () =>
      json(await ctx.db.selectFrom('projects').select(['key', 'name']).orderBy('key').execute()),
  )

  server.registerTool(
    'list_tasks',
    {
      description:
        'List the tasks of one project, in every state, ordered by number, each with key, title and state. `project` is a project key (case is ignored). The optional `filter` is trimmed, and keeps only the tasks whose title or description contains it as a case-insensitive, literal substring.',
      inputSchema: { project: z.string(), filter: z.string().optional() },
    },
    async (input) => {
      const key = foldKey(input.project)
      const project = await ctx.db
        .selectFrom('projects')
        .select('id')
        .where('key', '=', key)
        .executeTakeFirst()
      if (project === undefined) return unknownProject(ctx, key)
      const pattern = filterPattern(input.filter)
      let query = ctx.db
        .selectFrom('tasks')
        .select(['number', 'title', 'state'])
        .where('project_id', '=', project.id)
      if (pattern !== null)
        query = query.where((eb) =>
          eb.or([
            eb(sql`lower(title)`, 'like', sql`lower(${pattern}) escape '\\'`),
            eb(sql`lower(description_md)`, 'like', sql`lower(${pattern}) escape '\\'`),
          ]),
        )
      const tasks = await query.orderBy('number').execute()
      return json(tasks.map((t) => ({ key: `${key}-${t.number}`, title: t.title, state: t.state })))
    },
  )

  server.registerTool(
    'read_task',
    {
      description:
        'Read one task of any project by its key, such as ZLR-12 (case is ignored): key, title, state, description_md, and spec, the task’s highest spec version as { version, status, body_md } or null when it has none.',
      inputSchema: { key: z.string() },
    },
    async (input) => {
      const parsed = parseTaskKey(input.key)
      if (parsed === null)
        return reply(
          `${foldKey(input.key)} is not a task key: a task key is a project key, a hyphen and a number, such as ZLR-12.`,
          true,
        )
      const project = await ctx.db
        .selectFrom('projects')
        .select('id')
        .where('key', '=', parsed.project)
        .executeTakeFirst()
      if (project === undefined) return unknownProject(ctx, parsed.project, parsed.folded)
      const task = await ctx.db
        .selectFrom('tasks')
        .select(['id', 'title', 'state', 'description_md'])
        .where('project_id', '=', project.id)
        .where('number', '=', parsed.number)
        .executeTakeFirst()
      if (task === undefined)
        return reply(
          `${parsed.project} has no task numbered ${parsed.number}: ${parsed.folded} does not exist.`,
          true,
        )
      const spec = await ctx.db
        .selectFrom('specs')
        .select(['version', 'status', 'body_md'])
        .where('task_id', '=', task.id)
        .orderBy('version', 'desc')
        .executeTakeFirst()
      return json({
        key: parsed.folded,
        title: task.title,
        state: task.state,
        description_md: task.description_md,
        spec: spec ?? null,
      })
    },
  )
}
