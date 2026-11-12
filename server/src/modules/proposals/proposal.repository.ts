import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { ProposalOutcome } from '../../shared/vocabulary.js'
import { offeredVariants } from './proposal.rules.js'

type Db = Kysely<Database> | Transaction<Database>

export interface ProposalView {
  id: string
  run: { kind: 'spec' | 'delivery'; number: number }
  phase: string
  number: number
  project: string
  title: string
  description_md: string
  related: boolean
  bearing_md: string | null
  workaround_md: string | null
  offered: ProposalOutcome[]
  outcome: ProposalOutcome | null
  filed_task: { id: string; key: string; title: string } | null
  created_at: Date
  settled_at: Date | null
}

/** Every proposal of a task's spec and delivery runs, newest run first, then by number. */
export async function proposalsOf(db: Db, taskId: string): Promise<ProposalView[]> {
  const rows = await db
    .selectFrom('proposals')
    .innerJoin('runs', 'runs.id', 'proposals.run_id')
    .innerJoin('phases', 'phases.id', 'proposals.phase_id')
    .innerJoin('projects', 'projects.id', 'proposals.project_id')
    .leftJoin('tasks as filed', 'filed.id', 'proposals.filed_task_id')
    .leftJoin('projects as filed_project', 'filed_project.id', 'filed.project_id')
    .leftJoin('approval_requests', 'approval_requests.id', 'proposals.approval_id')
    .select([
      'proposals.id',
      'runs.kind as run_kind',
      'runs.number as run_number',
      'phases.name as phase',
      'proposals.number',
      'projects.key as project',
      'proposals.title',
      'proposals.description_md',
      'proposals.related',
      'proposals.bearing_md',
      'proposals.workaround_md',
      'proposals.outcome',
      'proposals.created_at',
      'proposals.settled_at',
      'filed.id as filed_id',
      'filed.number as filed_number',
      'filed.title as filed_title',
      'filed_project.key as filed_key',
      'approval_requests.status as approval_status',
    ])
    .where('proposals.task_id', '=', taskId)
    .where('runs.kind', 'in', ['spec', 'delivery'])
    .orderBy('runs.created_at', 'desc')
    .orderBy('proposals.number')
    .execute()
  return rows.map((row) => ({
    id: row.id,
    run: { kind: row.run_kind as 'spec' | 'delivery', number: row.run_number },
    phase: row.phase,
    number: row.number,
    project: row.project,
    title: row.title,
    description_md: row.description_md,
    related: row.related,
    bearing_md: row.bearing_md,
    workaround_md: row.workaround_md,
    offered:
      row.outcome !== null
        ? []
        : offeredVariants({
            related: row.related,
            hasWorkaround: row.workaround_md !== null,
            approval: row.approval_status as 'open' | 'expired' | 'withdrawn' | 'answered' | null,
          }),
    outcome: row.outcome,
    filed_task:
      row.filed_id === null
        ? null
        : {
            id: row.filed_id,
            key: `${row.filed_key}-${row.filed_number}`,
            title: row.filed_title ?? '',
          },
    created_at: row.created_at,
    settled_at: row.settled_at,
  }))
}

/** The ids of a task's open proposals: what the proposal decision reads. */
export async function openProposalIds(db: Db, taskId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('proposals')
    .select('id')
    .where('task_id', '=', taskId)
    .where('outcome', 'is', null)
    .orderBy('created_at')
    .execute()
  return rows.map((row) => row.id)
}
