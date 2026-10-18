import { sql, type Kysely, type Transaction } from 'kysely'
import pg from 'pg'
import type { Database } from '../db/schema.js'

export type BoardMessage =
  | { topic: 'task.updated'; taskId: string }
  | { topic: 'run.queued'; runId: string }
  | { topic: 'run.event'; runId: string; taskId: string }

const CHANNEL = 'board'

/** Delivered at commit when called inside a transaction, and never if it rolls back. */
export async function publish(
  db: Kysely<Database> | Transaction<Database>,
  message: BoardMessage,
): Promise<void> {
  await sql`select pg_notify(${CHANNEL}, ${JSON.stringify(message)})`.execute(db)
}

/** One dedicated connection listening on the channel, fanned out to in-process subscribers. */
export class Bus {
  private client: pg.Client | undefined
  private readonly subscribers = new Set<(message: BoardMessage) => void>()

  constructor(private readonly databaseUrl: string) {}

  async start(): Promise<void> {
    const client = new pg.Client({ connectionString: this.databaseUrl })
    await client.connect()
    client.on('notification', (notification) => {
      if (notification.channel !== CHANNEL || notification.payload === undefined) return
      const message = JSON.parse(notification.payload) as BoardMessage
      for (const subscriber of this.subscribers) subscriber(message)
    })
    await client.query(`listen ${CHANNEL}`)
    this.client = client
  }

  async stop(): Promise<void> {
    await this.client?.end()
    this.client = undefined
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
