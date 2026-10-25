import { useEffect } from 'react'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

export type BoardMessage =
  | { topic: 'task.updated'; taskId: string }
  | { topic: 'run.event'; runId: string; taskId: string }
  | { topic: 'approval.requested'; taskId: string }
  | { topic: 'approval.answered'; taskId: string }
  | { topic: 'resync' }

/** What a message from the server makes stale. Prefix keys refresh every query under them. */
export function keysFor(message: BoardMessage): QueryKey[] {
  if (message.topic === 'task.updated')
    return [
      ['board'],
      ['task', message.taskId],
      ['specs', message.taskId],
      ['runs', message.taskId],
      // A cancel withdraws a question and the sweeper expires one; both send only this.
      ['approvals', message.taskId],
      ['approvals', 'open'],
    ]
  // The server's connection to the database came back; whatever it missed meanwhile is unknown.
  if (message.topic === 'resync') return [[]]
  if (message.topic === 'approval.requested' || message.topic === 'approval.answered')
    return [
      ['approvals', message.taskId],
      ['approvals', 'open'],
      ['task', message.taskId],
      ['board'],
    ]
  // A spec run's save arrives as a run event: the Spec tab shows each version it saves.
  return [
    ['board'],
    ['runs', message.taskId],
    ['costs', message.taskId],
    ['events', message.runId],
    ['specs', message.taskId],
  ]
}

export function useBoardStream(client: QueryClient): void {
  useEffect(() => {
    const source = new EventSource('/api/stream')
    const handle = (event: MessageEvent<string>) => {
      for (const queryKey of keysFor(JSON.parse(event.data) as BoardMessage))
        void client.invalidateQueries({ queryKey })
    }
    for (const topic of [
      'task.updated',
      'run.event',
      'approval.requested',
      'approval.answered',
      'resync',
    ])
      source.addEventListener(topic, handle)
    return () => source.close()
  }, [client])
}
