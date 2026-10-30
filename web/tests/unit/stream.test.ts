import { describe, expect, it } from 'vitest'
import { keysFor } from '../../src/stream'

describe('keysFor', () => {
  it.each([
    [
      { topic: 'task.updated', taskId: 't' },
      [
        ['board'],
        ['task', 't'],
        ['specs', 't'],
        ['runs', 't'],
        ['approvals', 't'],
        ['approvals', 'open'],
      ],
    ],
    [
      { topic: 'run.event', runId: 'r', taskId: 't' },
      // A spec run's save arrives as a run event: the Spec tab shows each version it saves.
      [['board'], ['runs', 't'], ['costs', 't'], ['events', 'r'], ['specs', 't']],
    ],
    [{ topic: 'project.updated', key: 'PAY' }, [['projects'], ['test-commands', 'PAY']]],
    // Notices sent while the server's connection was down are lost: everything is refetched.
    [{ topic: 'resync' }, [[]]],
  ] as const)('refreshes what %j changes', (message, keys) => {
    expect(keysFor(message)).toEqual(keys)
  })
})
