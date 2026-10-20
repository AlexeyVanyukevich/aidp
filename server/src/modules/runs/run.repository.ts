import { sql, type Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

export interface PhaseView {
  id: string
  name: string
  attempt: number
  agent: string
  model: string
  status: string
  summary_md: string | null
  started_at: Date
  ended_at: Date | null
  /** A process of the phase was stopped: its cost is not compared (spec §7). */
  interrupted: boolean
}
export interface ArtifactView {
  id: string
  kind: string
  phase_id: string | null
  body_md: string
  uri: string | null
  data: unknown
}
export interface RunView {
  id: string
  number: number
  kind: string
  status: string
  spec_version: number
  current_phase: string | null
  branch: string | null
  pr_number: number | null
  pr_url: string | null
  failure_reason: string | null
  fix_loops: number
  created_at: Date
  started_at: Date | null
  ended_at: Date | null
  phases: PhaseView[]
  artifacts: ArtifactView[]
}
export interface EventView {
  id: string
  phase_id: string | null
  ts: Date
  type: string
  agent: string | null
  model: string | null
  tool: string | null
  target: string | null
  status: string | null
  duration_ms: number | null
  usage: { input: number; output: number; cache_read: number; cache_write: number }
  payload: Record<string, unknown>
}

export class RunRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async forTask(taskId: string): Promise<RunView[]> {
    const runs = await this.db
      .selectFrom('runs')
      .select([
        'id',
        'kind',
        'status',
        'spec_version',
        'current_phase',
        'branch',
        'pr_number',
        'pr_url',
        'failure_reason',
        'fix_loops',
        'created_at',
        'started_at',
        'ended_at',
        sql<number>`row_number() over (partition by task_id order by created_at)::int`.as('number'),
      ])
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'desc')
      .execute()
    if (runs.length === 0) return []
    const runIds = runs.map((run) => run.id)
    const phases = await this.db
      .selectFrom('phases')
      .select([
        'id',
        'run_id',
        'name',
        'attempt',
        'agent',
        'model',
        'status',
        'summary_md',
        'started_at',
        'ended_at',
        'interrupted',
      ])
      .where('run_id', 'in', runIds)
      .orderBy('started_at')
      .execute()
    const artifacts = await this.db
      .selectFrom('artifacts')
      .select(['id', 'run_id', 'kind', 'phase_id', 'body_md', 'uri', 'data'])
      .where('run_id', 'in', runIds)
      .orderBy('created_at')
      .execute()
    return runs.map((run) => ({
      ...run,
      phases: phases.filter((p) => p.run_id === run.id).map(({ run_id: _r, ...phase }) => phase),
      artifacts: artifacts
        .filter((a) => a.run_id === run.id)
        .map(({ run_id: _r, ...artifact }) => artifact),
    }))
  }

  async taskOf(runId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('runs')
      .select('task_id')
      .where('id', '=', runId)
      .executeTakeFirst()
    return row?.task_id
  }

  async events(
    runId: string,
    after: { ts: Date; id: string } | undefined,
    limit: number,
  ): Promise<EventView[]> {
    let query = this.db
      .selectFrom('events')
      .select([
        'id',
        'phase_id',
        'ts',
        'type',
        'agent',
        'model',
        'tool',
        'target',
        'status',
        'duration_ms',
        'input',
        'output',
        'cache_read',
        'cache_write',
        'payload',
      ])
      .where('run_id', '=', runId)
    if (after !== undefined) {
      query = query.where((eb) => eb(eb.refTuple('ts', 'id'), '>', eb.tuple(after.ts, after.id)))
    }
    const rows = await query.orderBy('ts').orderBy('id').limit(limit).execute()
    return rows.map(({ input, output, cache_read, cache_write, ...rest }) => ({
      ...rest,
      usage: { input, output, cache_read, cache_write },
    }))
  }

  /** The latest run of each task, with the attempt its current phase is on. */
  async latestByTask(
    taskIds: string[],
  ): Promise<Map<string, { phase: string | null; attempt: number | null; pr_url: string | null }>> {
    if (taskIds.length === 0) return new Map()
    const runs = await this.db
      .selectFrom('runs')
      .select(['id', 'task_id', 'current_phase', 'pr_url'])
      .where('task_id', 'in', taskIds)
      .distinctOn('task_id')
      .orderBy('task_id')
      .orderBy('created_at', 'desc')
      .execute()
    const attempts =
      runs.length === 0
        ? []
        : await this.db
            .selectFrom('phases')
            .select(['run_id', 'name', (eb) => eb.fn.max('attempt').as('attempt')])
            .where(
              'run_id',
              'in',
              runs.map((run) => run.id),
            )
            .groupBy(['run_id', 'name'])
            .execute()
    return new Map(
      runs.map((run) => {
        const attempt =
          attempts.find((a) => a.run_id === run.id && a.name === run.current_phase)?.attempt ?? null
        return [run.task_id, { phase: run.current_phase, attempt, pr_url: run.pr_url }]
      }),
    )
  }
}
