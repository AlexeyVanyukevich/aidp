import { sql, type Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { costOf, priceAt, type PriceRow } from './pricing.js'
import { summarizeCosts, type CostSummary } from './summarize.js'

export async function loadPrices(db: Kysely<Database>): Promise<PriceRow[]> {
  const rows = await db.selectFrom('prices').selectAll().execute()
  return rows.map((row) => ({
    model: row.model,
    effectiveFrom: row.effective_from.toISOString().slice(0, 10),
    input: Number(row.input),
    output: Number(row.output),
    cacheRead: Number(row.cache_read),
    cacheWrite: Number(row.cache_write),
  }))
}

export class CostService {
  constructor(private readonly db: Kysely<Database>) {}

  async forTask(taskId: string): Promise<CostSummary> {
    const events = await this.db
      .selectFrom('events')
      .innerJoin('runs', 'runs.id', 'events.run_id')
      .select([
        'events.phase_id',
        'events.agent',
        'events.model',
        'events.ts',
        'events.input',
        'events.output',
        'events.cache_read',
        'events.cache_write',
        'events.payload',
      ])
      .where('runs.task_id', '=', taskId)
      .where('events.model', 'is not', null)
      .execute()
    const phases = await this.db
      .selectFrom('phases')
      .innerJoin('runs', 'runs.id', 'phases.run_id')
      .select([
        'phases.id',
        'phases.name',
        'phases.attempt',
        'phases.reported_cost',
        'phases.interrupted',
      ])
      .where('runs.task_id', '=', taskId)
      .orderBy('phases.started_at')
      .execute()
    return summarizeCosts({
      events: events.map((e) => ({
        phaseId: e.phase_id,
        agent: e.agent,
        model: e.model,
        ts: e.ts,
        usage: {
          input: e.input,
          output: e.output,
          cacheRead: e.cache_read,
          cacheWrite: e.cache_write,
        },
        cut: e.payload.cut === true,
      })),
      phases: phases.map((p) => ({
        id: p.id,
        name: p.name,
        attempt: p.attempt,
        reportedCost: p.reported_cost,
        interrupted: p.interrupted,
      })),
      prices: await loadPrices(this.db),
    })
  }

  /** Dollars per task for the board: usage summed per model and day, then priced. */
  async totals(
    taskIds: string[],
  ): Promise<Map<string, { usd: number; complete: boolean; models: string[] }>> {
    const result = new Map<string, { usd: number; complete: boolean; models: string[] }>()
    if (taskIds.length === 0) return result
    const rows = await this.db
      .selectFrom('events')
      .innerJoin('runs', 'runs.id', 'events.run_id')
      .select((eb) => [
        'runs.task_id',
        'events.model',
        eb.fn<Date>('date_trunc', [eb.val('day'), eb.ref('events.ts')]).as('day'),
        eb.fn.sum<number>('events.input').as('input'),
        eb.fn.sum<number>('events.output').as('output'),
        eb.fn.sum<number>('events.cache_read').as('cache_read'),
        eb.fn.sum<number>('events.cache_write').as('cache_write'),
      ])
      .where('runs.task_id', 'in', taskIds)
      .where('events.model', 'is not', null)
      // As in summarizeCosts: a phase_start names its configured alias and used no tokens.
      .where(sql`events.input + events.output + events.cache_read + events.cache_write`, '>', 0)
      .groupBy(['runs.task_id', 'events.model', 'day'])
      .execute()
    const prices = await loadPrices(this.db)
    for (const row of rows) {
      const entry = result.get(row.task_id) ?? { usd: 0, complete: true, models: [] }
      const model = row.model ?? ''
      const price = priceAt(prices, model, new Date(row.day))
      if (price === undefined) entry.complete = false
      else
        entry.usd += costOf(
          {
            input: Number(row.input),
            output: Number(row.output),
            cacheRead: Number(row.cache_read),
            cacheWrite: Number(row.cache_write),
          },
          price,
        )
      if (!entry.models.includes(model)) entry.models.push(model)
      result.set(row.task_id, entry)
    }
    return result
  }
}
