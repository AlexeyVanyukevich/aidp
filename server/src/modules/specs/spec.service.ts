import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js'
import type { SpecCriterion } from '../../shared/vocabulary.js'
import { moveTask } from '../tasks/task.moves.js'
import { parseSpec, type LintFinding } from './spec-parser.js'
import type { SpecRepository, SpecRow } from './spec.repository.js'

export interface SpecView {
  id: string
  version: number
  body_md: string
  status: SpecRow['status']
  approved_at: string | null
  lint: {
    requirements: string[]
    criteria: SpecCriterion[]
    open_questions: string[]
    findings: LintFinding[]
    approvable: boolean
  }
}

export function toSpecView(row: SpecRow): SpecView {
  const parsed = parseSpec(row.body_md)
  return {
    id: row.id,
    version: row.version,
    body_md: row.body_md,
    status: row.status,
    approved_at: row.approved_at?.toISOString() ?? null,
    lint: {
      requirements: parsed.requirements.map((r) => r.id),
      criteria: parsed.criteria,
      open_questions: parsed.openQuestions,
      findings: parsed.findings,
      approvable: parsed.approvable,
    },
  }
}

export async function queueDeliveryRun(
  trx: Transaction<Database>,
  taskId: string,
  specVersion: number,
  now: Date,
): Promise<string> {
  const { count } = await trx
    .selectFrom('runs')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('task_id', '=', taskId)
    .where('kind', '=', 'delivery')
    .executeTakeFirstOrThrow()
  const run = await trx
    .insertInto('runs')
    .values({
      task_id: taskId,
      kind: 'delivery',
      number: Number(count) + 1,
      spec_version: specVersion,
      status: 'queued',
      queued_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await publish(trx, { topic: 'run.queued', runId: run.id })
  return run.id
}

export class SpecService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly specs: SpecRepository,
    private readonly clock: () => Date,
  ) {}

  async list(taskId: string): Promise<SpecView[]> {
    return (await this.specs.list(taskId)).map(toSpecView)
  }

  async save(taskId: string, body: string): Promise<SpecView> {
    const row = await this.db.transaction().execute(async (trx) => {
      await moveTask(trx, taskId, 'save_spec')
      return this.specs.insertVersion(trx, taskId, body)
    })
    return toSpecView(row)
  }

  async approve(specId: string): Promise<{ spec: SpecView; run_id: string }> {
    return this.db.transaction().execute(async (trx) => {
      const spec = await this.specs.get(trx, specId)
      if (spec === undefined) throw new NotFoundError('No such spec')
      if (spec.status !== 'draft') {
        throw new ConflictError(`This version is ${spec.status}; reload to see the latest`, {
          status: spec.status,
        })
      }
      const parsed = parseSpec(spec.body_md)
      if (!parsed.approvable) {
        throw new ValidationError('The spec cannot be approved yet', {
          findings: parsed.findings,
          open_questions: parsed.openQuestions,
        })
      }
      await moveTask(trx, spec.task_id, 'approve')
      const at = this.clock()
      await this.specs.approve(trx, spec.id, parsed.criteria, at)
      const runId = await queueDeliveryRun(trx, spec.task_id, spec.version, at)
      return { spec: toSpecView({ ...spec, status: 'approved', approved_at: at }), run_id: runId }
    })
  }
}
