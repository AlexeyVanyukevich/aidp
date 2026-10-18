import { useEffect } from 'react'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

export type BoardMessage =
  { topic: 'task.updated'; taskId: string } | { topic: 'run.event'; runId: string; taskId: string }

/** What a message from the server makes stale. Prefix keys refresh every query under them. */
export function keysFor(message: BoardMessage): QueryKey[] {
  if (message.topic === 'task.updated')
    return [
      ['board'],
      ['task', message.taskId],
      ['specs', message.taskId],
      ['runs', message.taskId],
    ]
  return [['board'], ['runs', message.taskId], ['costs', message.taskId], ['events', message.runId]]
}

export function useBoardStream(client: QueryClient): void {
  useEffect(() => {
    const source = new EventSource('/api/stream')
    const handle = (event: MessageEvent<string>) => {
      for (const queryKey of keysFor(JSON.parse(event.data) as BoardMessage))
        void client.invalidateQueries({ queryKey })
    }
    source.addEventListener('task.updated', handle)
    source.addEventListener('run.event', handle)
    return () => source.close()
  }, [client])
}
