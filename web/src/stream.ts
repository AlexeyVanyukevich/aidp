import { useEffect } from 'react'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

export type BoardMessage =
  | { topic: 'task.updated'; taskId: string }
  | { topic: 'run.event'; runId: string; taskId: string }
  | { topic: 'resync' }

/** What a message from the server makes stale. Prefix keys refresh every query under them. */
export function keysFor(message: BoardMessage): QueryKey[] {
  if (message.topic === 'task.updated')
    return [
      ['board'],
      ['task', message.taskId],
      ['specs', message.taskId],
      ['runs', message.taskId],
    ]
  // The server's connection to the database came back; whatever it missed meanwhile is unknown.
  if (message.topic === 'resync') return [[]]
  return [['board'], ['runs', message.taskId], ['costs', message.taskId], ['events', message.runId]]
}

export function useBoardStream(client: QueryClient): void {
  useEffect(() => {
    const source = new EventSource('/api/stream')
    const handle = (event: MessageEvent<string>) => {
      for (const queryKey of keysFor(JSON.parse(event.data) as BoardMessage))
        void client.invalidateQueries({ queryKey })
    }
    for (const topic of ['task.updated', 'run.event', 'resync'])
      source.addEventListener(topic, handle)
    return () => source.close()
  }, [client])
}
