import { sql, type Kysely, type Transaction } from 'kysely'
import pg from 'pg'
import type { Database } from '../db/schema.js'

export type BoardMessage =
  | { topic: 'task.updated'; taskId: string }
  | { topic: 'run.queued'; runId: string }
  | { topic: 'run.event'; runId: string; taskId: string }
  /** Sent in-process after the listening connection comes back: notices meanwhile are lost. */
  | { topic: 'resync' }

const CHANNEL = 'board'

/** Delivered at commit when called inside a transaction, and never if it rolls back. */
export async function publish(
  db: Kysely<Database> | Transaction<Database>,
  message: BoardMessage,
): Promise<void> {
  await sql`select pg_notify(${CHANNEL}, ${JSON.stringify(message)})`.execute(db)
}

export interface BusOptions {
  /** The first wait before reconnecting; it doubles on each failure, up to `maxDelayMs`. */
  firstDelayMs?: number
  maxDelayMs?: number
  log?: (message: string, error?: unknown) => void
}

/**
 * One dedicated connection listening on the channel, fanned out to in-process subscribers. When
 * the database ends the connection — a restart, an administrator — it reconnects with backoff
 * and listens again, rather than letting the connection's `error` stop the process.
 */
export class Bus {
  private client: pg.Client | undefined
  private stopped = false
  private timer: NodeJS.Timeout | undefined
  private delayMs: number
  private readonly subscribers = new Set<(message: BoardMessage) => void>()

  constructor(
    private readonly databaseUrl: string,
    private readonly options: BusOptions = {},
  ) {
    this.delayMs = options.firstDelayMs ?? 1_000
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    const client = this.client
    this.client = undefined
    await client?.end().catch(() => undefined)
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.databaseUrl })
    // Both can fire for one loss; `lost` acts on the current client once.
    client.on('error', (error) => this.lost(client, error))
    client.on('end', () => this.lost(client))
    client.on('notification', (notification) => {
      if (notification.channel !== CHANNEL || notification.payload === undefined) return
      this.emit(JSON.parse(notification.payload) as BoardMessage)
    })
    try {
      await client.connect()
      await client.query(`listen ${CHANNEL}`)
    } catch (error) {
      await client.end().catch(() => undefined)
      throw error
    }
    this.client = client
    this.delayMs = this.options.firstDelayMs ?? 1_000
  }

  private lost(client: pg.Client, error?: unknown): void {
    if (client !== this.client) return
    this.client = undefined
    client.end().catch(() => undefined)
    if (this.stopped) return
    this.options.log?.('the bus lost its database connection; reconnecting', error)
    this.reconnect()
  }

  private reconnect(): void {
    const wait = this.delayMs
    this.delayMs = Math.min(this.delayMs * 2, this.options.maxDelayMs ?? 30_000)
    this.timer = setTimeout(() => {
      if (this.stopped) return
      this.connect().then(
        () => this.emit({ topic: 'resync' }),
        (error: unknown) => {
          this.options.log?.('the bus could not reconnect yet', error)
          this.reconnect()
        },
      )
    }, wait)
  }

  private emit(message: BoardMessage): void {
    for (const subscriber of this.subscribers) subscriber(message)
  }

  subscribe(subscriber: (message: BoardMessage) => void): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  /** The next message on `topic`, or `undefined` once `timeoutMs` passes. */
  next(topic: BoardMessage['topic'], timeoutMs: number): Promise<BoardMessage | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe()
        resolve(undefined)
      }, timeoutMs)
      const unsubscribe = this.subscribe((message) => {
        if (message.topic !== topic) return
        clearTimeout(timer)
        unsubscribe()
        resolve(message)
      })
    })
  }
}
