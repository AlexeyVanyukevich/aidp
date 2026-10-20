import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js'
import type { ApprovalKind, ApprovalStatus, Block } from '../../shared/vocabulary.js'
import { moveTask } from '../tasks/task.moves.js'
import {
  checkAnswer,
  checkRequest,
  optionsFor,
  resumeMessage,
  type Answer,
  type ApprovalOption,
} from './approval-rules.js'

export interface OpenRequest {
  /** Given by the runner for its plan gate, so a replayed event opens nothing twice. */
  id?: string
  runId: string
  taskId: string
  phaseId: string
  kind: ApprovalKind
  question: string
  options: ApprovalOption[]
  recommendation?: string | null
  context_md?: string | null
  files?: string[] | null
}

export interface ApprovalView {
  id: string
  run_id: string
  phase_id: string | null
  kind: ApprovalKind
  question: string
  options: ApprovalOption[]
  recommendation: string | null
  context_md: string | null
  files: string[] | null
  status: ApprovalStatus
  answer: Answer | null
  created_at: Date
  answered_at: Date | null
}

export type OpenApprovalView = ApprovalView & {
  task_id: string
  task_key: string
  project_key: string
}

const COLUMNS = [
  'approval_requests.id',
  'approval_requests.run_id',
  'approval_requests.phase_id',
  'approval_requests.kind',
  'approval_requests.question',
  'approval_requests.options',
  'approval_requests.recommendation',
  'approval_requests.context_md',
  'approval_requests.files',
  'approval_requests.status',
  'approval_requests.answer',
  'approval_requests.created_at',
  'approval_requests.answered_at',
] as const

type Row = Omit<ApprovalView, 'options' | 'answer'> & { options: unknown[]; answer: unknown }
const toView = <T extends Row>(row: T) => ({
  ...row,
  options: row.options as ApprovalOption[],
  answer: (row.answer ?? null) as Answer | null,
})

/**
 * Opens a request and pauses everything it stops: the phase, the run and the card (spec §5).
 * `recordEvent` is false when the request arrives as a runner event, which is its own record.
 */
export async function openApproval(
  trx: Transaction<Database>,
  request: OpenRequest,
  now: Date,
  options: { recordEvent: boolean },
): Promise<{ id: string; opened: boolean }> {
  if (request.id !== undefined) {
    const existing = await trx
      .selectFrom('approval_requests')
      .select('id')
      .where('id', '=', request.id)
      .executeTakeFirst()
    if (existing !== undefined) return { id: existing.id, opened: false }
  }
  const findings = checkRequest(request)
  if (findings.length > 0)
    throw new ValidationError('The approval request is not valid', { findings })

  const waiting = await trx
    .selectFrom('approval_requests')
    .select('id')
    .where('run_id', '=', request.runId)
    .where('status', '=', 'open')
    .forUpdate()
    .executeTakeFirst()
  if (waiting !== undefined) throw new ConflictError('This run is already waiting for an answer')
  const phase = await trx
    .selectFrom('phases')
    .select(['name', 'attempt', 'session_id', 'status'])
    .where('id', '=', request.phaseId)
    .where('run_id', '=', request.runId)
    .forUpdate()
    .executeTakeFirst()
  if (phase?.status !== 'running') throw new ConflictError('No phase of this run is running')

  const { id } = await trx
    .insertInto('approval_requests')
    .values({
      ...(request.id === undefined ? {} : { id: request.id }),
      run_id: request.runId,
      phase_id: request.phaseId,
      kind: request.kind,
      question: request.question.trim(),
      options: JSON.stringify(optionsFor(request.kind, request.options)),
      recommendation: request.recommendation ?? null,
      context_md: request.context_md ?? null,
      status: 'open',
      answer: null,
      checkpoint: JSON.stringify({
        phase: phase.name,
        attempt: phase.attempt,
        session_id: phase.session_id,
      }),
      files: request.kind === 'out_of_plan' ? JSON.stringify(request.files ?? []) : null,
      created_at: now,
      answered_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  if (options.recordEvent) {
    await trx
      .insertInto('events')
      .values({
        id: crypto.randomUUID(),
        run_id: request.runId,
        phase_id: request.phaseId,
        ts: now,
        type: 'approval_requested',
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
        payload: JSON.stringify({
          approval_id: id,
          kind: request.kind,
          question: request.question.trim(),
        }),
      })
      .execute()
  }
  await trx
    .updateTable('phases')
    .set({ status: 'paused' })
    .where('id', '=', request.phaseId)
    .execute()
  await trx.updateTable('runs').set({ status: 'paused' }).where('id', '=', request.runId).execute()
  await moveTask(trx, request.taskId, 'request_approval')
  await publish(trx, { topic: 'approval.requested', taskId: request.taskId })
  return { id, opened: true }
}

export class ApprovalService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: () => Date,
  ) {}

  /** Answers a request and queues its run's resume, in one transaction (spec §5). */
  async answer(id: string, body: Answer): Promise<ApprovalView> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('approval_requests')
        .innerJoin('runs', 'runs.id', 'approval_requests.run_id')
        .innerJoin('tasks', 'tasks.id', 'runs.task_id')
        .select([...COLUMNS, 'runs.task_id', 'runs.block', 'tasks.state as task_state'])
        .where('approval_requests.id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (row === undefined) throw new NotFoundError('No such approval request')
      const block = row.block as Block | null
      // An expired question stays answerable while the card it blocked waits on it (spec §2).
      const answerable =
        row.status === 'open' ||
        (row.status === 'expired' &&
          row.task_state === 'blocked' &&
          block?.cause === 'approval_expired')
      if (!answerable)
        throw new ConflictError(`This request is ${row.status}; reload to see the latest`, {
          status: row.status,
        })

      const approval = toView(row)
      const findings = checkAnswer(approval, body)
      const first = findings[0]
      if (first !== undefined)
        throw new ValidationError('The answer is not valid', { field: first.field, findings })

      const now = this.clock()
      await trx
        .updateTable('approval_requests')
        .set({ status: 'answered', answer: JSON.stringify(body), answered_at: now })
        .where('id', '=', id)
        .execute()
      await trx
        .insertInto('events')
        .values({
          id: crypto.randomUUID(),
          run_id: row.run_id,
          phase_id: row.phase_id,
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
          payload: JSON.stringify({ approval_id: id, ...body }),
        })
        .execute()
      await moveTask(trx, row.task_id, 'answer')
      await trx
        .updateTable('runs')
        .set({
          status: 'queued',
          pending: 'resume',
          queued_at: now,
          resume_message: resumeMessage(approval, body),
          block: null,
        })
        .where('id', '=', row.run_id)
        .execute()
      await publish(trx, { topic: 'approval.answered', taskId: row.task_id })
      await publish(trx, { topic: 'run.queued', runId: row.run_id })
      const { task_id: _task, block: _block, task_state: _state, ...rest } = approval
      return { ...rest, status: 'answered', answer: body, answered_at: now }
    })
  }

  async forTask(taskId: string): Promise<ApprovalView[]> {
    const rows = await this.db
      .selectFrom('approval_requests')
      .innerJoin('runs', 'runs.id', 'approval_requests.run_id')
      .select(COLUMNS)
      .where('runs.task_id', '=', taskId)
      .orderBy('approval_requests.created_at', 'desc')
      .execute()
    return rows.map(toView)
  }

  /** Every open request, across projects, oldest first: the header's count reads this. */
  async open(): Promise<OpenApprovalView[]> {
    const rows = await this.db
      .selectFrom('approval_requests')
      .innerJoin('runs', 'runs.id', 'approval_requests.run_id')
      .innerJoin('tasks', 'tasks.id', 'runs.task_id')
      .innerJoin('projects', 'projects.id', 'tasks.project_id')
      .select([...COLUMNS, 'tasks.id as task_id', 'tasks.number', 'projects.key as project_key'])
      .where('approval_requests.status', '=', 'open')
      .orderBy('approval_requests.created_at')
      .execute()
    return rows.map(({ number, ...row }) => ({
      ...toView(row),
      task_key: `${row.project_key}-${number}`,
    }))
  }
}
