import { describe, expect, it } from 'vitest'
import { keysFor } from '../../src/stream'

describe('keysFor', () => {
  it.each([
    [
      { topic: 'task.updated', taskId: 't' },
      [['board'], ['task', 't'], ['specs', 't'], ['runs', 't']],
    ],
    [
      { topic: 'run.event', runId: 'r', taskId: 't' },
      [['board'], ['runs', 't'], ['costs', 't'], ['events', 'r']],
    ],
    // Notices sent while the server's connection was down are lost: everything is refetched.
    [{ topic: 'resync' }, [[]]],
  ] as const)('refreshes what %j changes', (message, keys) => {
    expect(keysFor(message)).toEqual(keys)
  })
})
