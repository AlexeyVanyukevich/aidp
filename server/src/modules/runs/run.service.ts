import { NotFoundError, ValidationError } from '../../shared/errors.js'
import type { EventView, RunRepository, RunView } from './run.repository.js'

/** `<ISO ts>|<id>` — the last event of a page, so the next starts strictly after it. */
function decodeCursor(cursor: string | undefined): { ts: Date; id: string } | undefined {
  if (cursor === undefined) return undefined
  const [ts, id] = cursor.split('|')
  const date = new Date(ts ?? '')
  if (id === undefined || Number.isNaN(date.getTime()))
    throw new ValidationError('after is not a cursor')
  return { ts: date, id }
}

export class RunService {
  constructor(private readonly runs: RunRepository) {}

  forTask(taskId: string): Promise<RunView[]> {
    return this.runs.forTask(taskId)
  }

  async get(runId: string): Promise<RunView> {
    const taskId = await this.runs.taskOf(runId)
    if (taskId === undefined) throw new NotFoundError('No such run')
    const run = (await this.runs.forTask(taskId)).find((r) => r.id === runId)
    if (run === undefined) throw new NotFoundError('No such run')
    return run
  }

  async events(
    runId: string,
    after: string | undefined,
    limit: number,
  ): Promise<{ events: EventView[]; next: string | null }> {
    const events = await this.runs.events(runId, decodeCursor(after), limit)
    const last = events.at(-1)
    return {
      events,
      next:
        events.length === limit && last !== undefined
          ? `${last.ts.toISOString()}|${last.id}`
          : null,
    }
  }
}
