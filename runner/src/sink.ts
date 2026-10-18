import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { BoardApi } from './api.js'
import { ApiError } from './api.js'
import { ZERO_USAGE, type EventType, type RunnerEvent } from './contract.js'

export function newEvent(
  base: {
    runId: string
    phaseId: string | null
    type: EventType
    agent?: string | null
    model?: string | null
  },
  fields: Partial<Omit<RunnerEvent, 'id' | 'run_id' | 'phase_id' | 'type'>> = {},
  clock: () => Date = () => new Date(),
  newId: () => string = randomUUID,
): RunnerEvent {
  return {
    id: newId(),
    run_id: base.runId,
    phase_id: base.phaseId,
    ts: clock().toISOString(),
    type: base.type,
    agent: base.agent ?? null,
    model: base.model ?? null,
    tool: null,
    target: null,
    status: null,
    duration_ms: null,
    usage: ZERO_USAGE,
    payload: {},
    ...fields,
  }
}

/** A network failure or a server error is worth retrying; a 4xx is the event's own fault. */
const retryable = (error: unknown) =>
  error instanceof TypeError || (error instanceof ApiError && error.status >= 500)

/**
 * Sends events to the board, keeping them in an ndjson file while it cannot be reached. Hooks
 * only ever append; the daemon is the one process that replays, so two replays never race.
 */
export class EventSink {
  constructor(
    private readonly api: BoardApi,
    private readonly file: string,
    private readonly token: () => string,
  ) {}

  async send(events: RunnerEvent[]): Promise<void> {
    if (events.length === 0) return
    try {
      await this.flush()
      await this.api.sendEvents(this.token(), events)
    } catch (error) {
      if (!retryable(error)) throw error
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, events.map((event) => `${JSON.stringify(event)}\n`).join(''))
    }
  }

  async flush(): Promise<void> {
    if (!existsSync(this.file)) return
    const lines = readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
    for (let start = 0; start < lines.length; start += 500) {
      const chunk = lines.slice(start, start + 500).map((line) => JSON.parse(line) as RunnerEvent)
      await this.api.sendEvents(this.token(), chunk)
      writeFileSync(
        this.file,
        lines
          .slice(start + 500)
          .map((line) => `${line}\n`)
          .join(''),
      )
    }
  }
}
