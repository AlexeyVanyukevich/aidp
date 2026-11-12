import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { ConflictError, NotFoundError } from '../../shared/errors.js'
import type { ProposalOutcome } from '../../shared/vocabulary.js'
import { settleHelps } from '../approvals/help.service.js'
import { openApproval } from '../approvals/approval.service.js'
import { TaskRepository } from '../tasks/task.repository.js'
import { moveFacts, moveTask } from '../tasks/task.moves.js'
import { proposalsOf, type ProposalView } from './proposal.repository.js'
import {
  DESCRIPTION_LIMIT,
  PROPOSAL_CAP,
  descriptionLength,
  filedDescription,
  offeredVariants,
  proposedByLine,
  proposedSummary,
  resumeText,
  runLabel,
  sameTitle,
  settledSummary,
  VARIANT_LABELS,
} from './proposal.rules.js'

/** A proposal the board will not take; the reply to the agent is the message. */
export class ProposalRefused extends Error {}

export interface ProposeInput {
  runId: string
  taskId: string
  phaseId: string
  agent: string | null
  targetProjectId: string
  title: string
  description_md: string
  related: boolean
  bearing_md: string | null
  workaround_md: string | null
}

export interface Proposed {
  id: string
  paused: boolean
}

async function recordMessage(
  trx: Transaction<Database>,
  input: {
    runId: string
    phaseId: string
    agent: string | null
    ts: Date
    summary: string
    proposalId: string
    outcome: ProposalOutcome | null
  },
): Promise<void> {
  await trx
    .insertInto('events')
    .values({
      id: crypto.randomUUID(),
      run_id: input.runId,
      phase_id: input.phaseId,
      ts: input.ts,
      type: 'message',
      agent: input.agent,
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
        proposal: { id: input.proposalId, outcome: input.outcome },
      }),
    })
    .execute()
}

/**
 * Every lock of a proposal's transaction is taken in one order (R13): the proposal row, the
 * target project, the proposing task, the run. Cancel takes the task and the run in that order.
 */
async function lockProjectTaskRun(
  trx: Transaction<Database>,
  locks: { projectId?: string; taskId?: string; runId?: string },
): Promise<void> {
  if (locks.projectId !== undefined)
    await trx
      .selectFrom('projects')
      .select('id')
      .where('id', '=', locks.projectId)
      .forNoKeyUpdate()
      .execute()
  if (locks.taskId !== undefined)
    await trx.selectFrom('tasks').select('id').where('id', '=', locks.taskId).forUpdate().execute()
  if (locks.runId !== undefined)
    await trx.selectFrom('runs').select('id').where('id', '=', locks.runId).forUpdate().execute()
}

export class ProposalService {
  private readonly tasks: TaskRepository

  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: () => Date,
  ) {
    this.tasks = new TaskRepository(db)
  }

  list(taskId: string): Promise<ProposalView[]> {
    return proposalsOf(this.db, taskId)
  }

  async listForTask(taskId: string): Promise<ProposalView[]> {
    const task = await this.db
      .selectFrom('tasks')
      .select('id')
      .where('id', '=', taskId)
      .executeTakeFirst()
    if (task === undefined) throw new NotFoundError('No such task')
    return proposalsOf(this.db, taskId)
  }

  /** Saves one proposal on the run; a related one also pauses it (R8, R11). */
  async propose(input: ProposeInput): Promise<Proposed> {
    const now = this.clock()
    return this.db.transaction().execute(async (trx) => {
      await lockProjectTaskRun(trx, {
        projectId: input.targetProjectId,
        taskId: input.taskId,
        runId: input.runId,
      })
      const phase = await trx
        .selectFrom('phases')
        .select(['name', 'status'])
        .where('id', '=', input.phaseId)
        .where('run_id', '=', input.runId)
        .executeTakeFirst()
      if (phase?.status !== 'running')
        throw new ProposalRefused('No phase of this run is running; nothing was saved.')

      const { count } = await trx
        .selectFrom('proposals')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('run_id', '=', input.runId)
        .executeTakeFirstOrThrow()
      const made = Number(count)
      if (made >= PROPOSAL_CAP)
        throw new ProposalRefused(
          `A run can make at most ${PROPOSAL_CAP} proposals and this one has reached the cap of ${PROPOSAL_CAP}. List your remaining findings in your report or summary instead.`,
        )

      const where = await trx
        .selectFrom('tasks')
        .innerJoin('projects', 'projects.id', 'tasks.project_id')
        .innerJoin('runs', 'runs.task_id', 'tasks.id')
        .select(['tasks.number', 'projects.key', 'runs.kind', 'runs.number as run_number'])
        .where('tasks.id', '=', input.taskId)
        .where('runs.id', '=', input.runId)
        .executeTakeFirstOrThrow()
      const taskKey = `${where.key}-${where.number}`
      const length = descriptionLength(input.description_md, {
        taskKey,
        kind: where.kind,
        runNumber: where.run_number,
        phase: phase.name,
      })
      if (length > DESCRIPTION_LIMIT)
        throw new ProposalRefused(
          `description_md would be ${length} characters with the proposed-by line; the limit is ${DESCRIPTION_LIMIT}.`,
        )

      await this.refuseDuplicate(trx, input)

      let approvalId: string | null = null
      const proposalId = crypto.randomUUID()
      if (input.related) {
        const offered = offeredVariants({
          related: true,
          hasWorkaround: input.workaround_md !== null,
          approval: 'open',
        })
        const opened = await openApproval(
          trx,
          {
            runId: input.runId,
            taskId: input.taskId,
            phaseId: input.phaseId,
            kind: 'proposal',
            question: input.title,
            options: offered.map((id) => ({ id, label: VARIANT_LABELS[id] })),
            context_md: input.bearing_md,
          },
          now,
          { recordEvent: true },
        )
        approvalId = opened.id
      }
      await trx
        .insertInto('proposals')
        .values({
          id: proposalId,
          run_id: input.runId,
          phase_id: input.phaseId,
          task_id: input.taskId,
          project_id: input.targetProjectId,
          number: made + 1,
          title: input.title,
          description_md: input.description_md,
          related: input.related,
          bearing_md: input.bearing_md,
          workaround_md: input.workaround_md,
          approval_id: approvalId,
          created_at: now,
        })
        .execute()
      await recordMessage(trx, {
        runId: input.runId,
        phaseId: input.phaseId,
        agent: input.agent,
        ts: now,
        summary: proposedSummary(input.title),
        proposalId,
        outcome: null,
      })
      await publish(trx, { topic: 'run.event', runId: input.runId, taskId: input.taskId })
      return { id: proposalId, paused: input.related }
    })
  }

  private async refuseDuplicate(trx: Transaction<Database>, input: ProposeInput): Promise<void> {
    const lowered = input.title.trim().toLowerCase()
    const task = await trx
      .selectFrom('tasks')
      .innerJoin('projects', 'projects.id', 'tasks.project_id')
      .select(['tasks.number', 'tasks.state', 'projects.key'])
      .where('tasks.project_id', '=', input.targetProjectId)
      .where((eb) => eb(eb.fn('lower', [eb.fn('btrim', ['tasks.title'])]), '=', lowered))
      .executeTakeFirst()
    if (task !== undefined)
      throw new ProposalRefused(
        `${task.key}-${task.number} (${task.state}) already has the title "${input.title}". Do not propose it again.`,
      )
    const proposals = await trx
      .selectFrom('proposals')
      .innerJoin('runs', 'runs.id', 'proposals.run_id')
      .innerJoin('tasks', 'tasks.id', 'runs.task_id')
      .innerJoin('projects', 'projects.id', 'tasks.project_id')
      .select([
        'proposals.title',
        'proposals.outcome',
        'proposals.run_id',
        'runs.kind',
        'runs.number as run_number',
        'tasks.number',
        'projects.key',
      ])
      .where('proposals.project_id', '=', input.targetProjectId)
      .where((eb) => eb(eb.fn('lower', [eb.fn('btrim', ['proposals.title'])]), '=', lowered))
      .where((eb) =>
        eb.or([eb('proposals.run_id', '=', input.runId), eb('proposals.outcome', 'is', null)]),
      )
      .execute()
    const hit = proposals.find((row) => sameTitle(row.title, input.title))
    if (hit === undefined) return
    const label = runLabel(hit.kind, hit.run_number)
    const who = hit.run_id === input.runId ? label : `${hit.key}-${hit.number}, ${label}`
    throw new ProposalRefused(
      `The proposal "${hit.title}" (${hit.outcome ?? 'open'}) of ${who} already has this title. Do not propose it again.`,
    )
  }

  /** Settles one proposal in one transaction (R12–R16). */
  async settle(
    taskId: string,
    proposalId: string,
    variant: ProposalOutcome,
    hooks: { beforeCommit?: (trx: Transaction<Database>) => Promise<void> } = {},
  ): Promise<ProposalView> {
    const now = this.clock()
    await this.db.transaction().execute(async (trx) => {
      const proposal = await trx
        .selectFrom('proposals')
        .selectAll()
        .where('id', '=', proposalId)
        .where('task_id', '=', taskId)
        .forUpdate()
        .executeTakeFirst()
      if (proposal === undefined) throw new NotFoundError('No such proposal')
      if (proposal.outcome !== null)
        throw new ConflictError('This proposal is settled already', { reason: 'settled' })

      const files = variant === 'file' || variant === 'workaround'
      await lockProjectTaskRun(trx, {
        ...(files ? { projectId: proposal.project_id } : {}),
        ...(proposal.related ? { taskId: proposal.task_id, runId: proposal.run_id } : {}),
      })

      const approval =
        proposal.approval_id === null
          ? null
          : await trx
              .selectFrom('approval_requests')
              .select(['id', 'status'])
              .where('id', '=', proposal.approval_id)
              .executeTakeFirstOrThrow()
      const offered = offeredVariants({
        related: proposal.related,
        hasWorkaround: proposal.workaround_md !== null,
        approval: (approval?.status ?? null) as
          'open' | 'expired' | 'withdrawn' | 'answered' | null,
      })
      if (!offered.includes(variant))
        throw new ConflictError(`${variant} is not offered for this proposal`, {
          reason: 'not_offered',
        })

      const phase = await trx
        .selectFrom('phases')
        .select('name')
        .where('id', '=', proposal.phase_id)
        .executeTakeFirstOrThrow()
      const origin = await trx
        .selectFrom('tasks')
        .innerJoin('projects', 'projects.id', 'tasks.project_id')
        .innerJoin('runs', 'runs.task_id', 'tasks.id')
        .select(['tasks.number', 'projects.key', 'runs.kind', 'runs.number as run_number'])
        .where('tasks.id', '=', proposal.task_id)
        .where('runs.id', '=', proposal.run_id)
        .executeTakeFirstOrThrow()
      const originKey = `${origin.key}-${origin.number}`

      let filed: { id: string; key: string } | null = null
      if (files) {
        const lowered = proposal.title.trim().toLowerCase()
        const clash = await trx
          .selectFrom('tasks')
          .innerJoin('projects', 'projects.id', 'tasks.project_id')
          .select(['tasks.number', 'tasks.state', 'tasks.title', 'projects.key'])
          .where('tasks.project_id', '=', proposal.project_id)
          .where((eb) => eb(eb.fn('lower', [eb.fn('btrim', ['tasks.title'])]), '=', lowered))
          .execute()
        const same = clash.find((row) => sameTitle(row.title, proposal.title))
        if (same !== undefined)
          throw new ConflictError(
            `${same.key}-${same.number} (${same.state}) already has this title`,
            { reason: 'duplicate', key: `${same.key}-${same.number}`, state: same.state },
          )
        const line = proposedByLine({
          taskKey: originKey,
          kind: origin.kind,
          runNumber: origin.run_number,
          phase: phase.name,
          outcome: variant,
        })
        const id = await this.tasks.insert(
          proposal.project_id,
          {
            title: proposal.title.trim(),
            description_md: filedDescription(proposal.description_md, line),
          },
          trx,
        )
        const row = await trx
          .selectFrom('tasks')
          .innerJoin('projects', 'projects.id', 'tasks.project_id')
          .select(['tasks.number', 'projects.key'])
          .where('tasks.id', '=', id)
          .executeTakeFirstOrThrow()
        filed = { id, key: `${row.key}-${row.number}` }
        await publish(trx, { topic: 'task.updated', taskId: id })
      }

      await trx
        .updateTable('proposals')
        .set({ outcome: variant, filed_task_id: filed?.id ?? null, settled_at: now })
        .where('id', '=', proposalId)
        .execute()
      await recordMessage(trx, {
        runId: proposal.run_id,
        phaseId: proposal.phase_id,
        agent: null,
        ts: now,
        summary: settledSummary(variant, filed?.key ?? null, proposal.title),
        proposalId,
        outcome: variant,
      })

      if (proposal.related && approval !== null && ['open', 'expired'].includes(approval.status)) {
        await trx
          .updateTable('approval_requests')
          .set({
            status: 'answered',
            answer: JSON.stringify({ option_id: variant }),
            answered_at: now,
          })
          .where('id', '=', approval.id)
          .execute()
        await trx
          .insertInto('events')
          .values({
            id: crypto.randomUUID(),
            run_id: proposal.run_id,
            phase_id: proposal.phase_id,
            ts: now,
            type: 'approval_answered',
            agent: null,
            model: null,
            tool: null,
            target: null,
            status: null,
            duration_ms: null,
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            payload: JSON.stringify({ approval_id: approval.id, option_id: variant }),
          })
          .execute()
        await moveTask(trx, proposal.task_id, 'answer', await moveFacts(trx, proposal.task_id))
        await trx
          .updateTable('runs')
          .set({
            status: 'queued',
            pending: 'resume',
            queued_at: now,
            resume_message: resumeText({
              outcome: variant as 'file' | 'workaround' | 'dismiss',
              key: filed?.key ?? null,
              title: proposal.title,
              phase: phase.name,
              workaround: proposal.workaround_md,
            }),
            block: null,
          })
          .where('id', '=', proposal.run_id)
          .execute()
        await publish(trx, { topic: 'approval.answered', taskId: proposal.task_id })
        await publish(trx, { topic: 'run.queued', runId: proposal.run_id })
      }
      await settleHelps(trx, proposal.task_id, now)
      await publish(trx, { topic: 'run.event', runId: proposal.run_id, taskId: proposal.task_id })
      await publish(trx, { topic: 'task.updated', taskId: proposal.task_id })
      await hooks.beforeCommit?.(trx)
    })
    const settled = (await proposalsOf(this.db, taskId)).find((view) => view.id === proposalId)
    if (settled === undefined) throw new NotFoundError('No such proposal')
    return settled
  }
}
