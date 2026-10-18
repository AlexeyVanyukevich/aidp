import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BoardApi } from '../../src/api.js'
import { EventSink, newEvent } from '../../src/sink.js'

const RUN = '00000000-0000-4000-8000-0000000000aa'

function fakeBoard(down: { value: boolean }) {
  const received: string[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (down.value) throw new TypeError('fetch failed')
    const body = JSON.parse(String(init?.body)) as { events: { id: string }[] }
    received.push(...body.events.map((e) => e.id))
    return new Response(JSON.stringify({ accepted: body.events.length }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { api: new BoardApi('http://board', 'k'.repeat(32), fetchImpl), received }
}

describe('EventSink', () => {
  it('sends events straight through while the board answers', async () => {
    const { api, received } = fakeBoard({ value: false })
    const file = join(mkdtempSync(join(tmpdir(), 'sink-')), 'events.ndjson')
    const event = newEvent({ runId: RUN, phaseId: null, type: 'message' })
    await new EventSink(api, file, () => 't').send([event])
    expect(received).toEqual([event.id])
    expect(existsSync(file)).toBe(false)
  })

  // Review Focus 3: the board is down, then back; the buffer replays once, in order.
  it('buffers while the board is down and replays in order before the next send', async () => {
    const down = { value: true }
    const { api, received } = fakeBoard(down)
    const file = join(mkdtempSync(join(tmpdir(), 'sink-')), 'events.ndjson')
    const sink = new EventSink(api, file, () => 't')
    const [a, b, c] = [1, 2, 3].map(() => newEvent({ runId: RUN, phaseId: null, type: 'message' }))

    await sink.send([a!])
    await sink.send([b!])
    expect(received).toEqual([])
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2)

    down.value = false
    await sink.send([c!])
    expect(received).toEqual([a!.id, b!.id, c!.id])
    expect(readFileSync(file, 'utf8')).toBe('')
  })
})
