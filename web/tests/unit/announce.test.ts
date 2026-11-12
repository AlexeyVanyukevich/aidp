import { describe, expect, it } from 'vitest'
import { createAnnouncer } from '../../src/announce'

function harness(initial = '') {
  const region = { text: initial, history: [initial] }
  const queue = new Map<number, () => void>()
  let next = 1
  const announcer = createAnnouncer({
    write: (value) => {
      region.text = typeof value === 'function' ? value(region.text) : value
      region.history.push(region.text)
    },
    request: (callback) => {
      const id = next++
      queue.set(id, callback)
      return id
    },
    cancel: (id) => {
      queue.delete(id)
    },
  })
  const frame = () => {
    const [id, callback] = [...queue.entries()][0] ?? []
    if (id === undefined || callback === undefined) return
    queue.delete(id)
    callback()
  }
  const plain = (text: string) => {
    region.text = text
    region.history.push(text)
  }
  return { region, queue, announcer, frame, plain }
}

describe('createAnnouncer', () => {
  it('announce empties the region, then refills it after two frames', () => {
    const h = harness('A')
    h.announcer.announce('A')
    expect(h.region.text).toBe('')
    h.frame()
    expect(h.region.text).toBe('')
    expect(h.queue.size).toBe(1)
    h.frame()
    expect(h.region.text).toBe('A')
    expect(h.queue.size).toBe(0)
  })

  it('a second announce cancels the first pending write', () => {
    const h = harness()
    h.announcer.announce('A')
    h.announcer.announce('B')
    expect(h.queue.size).toBe(1)
    h.frame()
    h.frame()
    expect(h.region.text).toBe('B')
    expect(h.region.history).not.toContain('A')
  })

  it('say cancels a pending announcement', () => {
    const h = harness()
    h.announcer.announce('A')
    h.announcer.say('C')
    expect(h.region.text).toBe('C')
    expect(h.queue.size).toBe(0)
    h.frame()
    h.frame()
    expect(h.region.text).toBe('C')
  })

  it('dispose cancels a pending announcement', () => {
    const h = harness()
    h.announcer.announce('A')
    h.announcer.dispose()
    expect(h.queue.size).toBe(0)
    h.frame()
    h.frame()
    expect(h.region.text).toBe('')
  })

  it('fills only a region that is still empty', () => {
    const h = harness()
    h.announcer.announce('A')
    h.frame()
    expect(h.queue.size).toBe(1)
    h.plain('D')
    h.frame()
    expect(h.region.text).toBe('D')
    expect(h.queue.size).toBe(0)
  })
})
