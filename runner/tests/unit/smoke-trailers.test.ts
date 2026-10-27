import { describe, expect, it } from 'vitest'
import { coAuthored } from '../../scripts/smoke-trailers.js'

const commit = (sha: string, message: string) => `${sha}\x1f${message}\n\x1e\n`

describe('coAuthored', () => {
  it('names every commit that carries a Co-Authored-By trailer, not only the last', () => {
    const log =
      commit('aaa', 'feat: one\n\nCo-Authored-By: Claude <noreply@anthropic.com>') +
      commit('bbb', 'feat: two\n\nBody.') +
      commit('ccc', 'feat: three\n\nBody.\n\nco-authored-by: Someone <a@b.c>')
    expect(coAuthored(log)).toEqual(['aaa', 'ccc'])
  })

  it('finds none in commits without one, or that only mention it in their body', () => {
    const log =
      commit('aaa', 'feat: one\n\nBody.') +
      commit(
        'bbb',
        'docs: Co-Authored-By is off\n\nThe Co-Authored-By trailer is removed.\n\nRefs: X',
      )
    expect(coAuthored(log)).toEqual([])
  })

  it('finds none in an empty log', () => {
    expect(coAuthored('')).toEqual([])
  })
})
