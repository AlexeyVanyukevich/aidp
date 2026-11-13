import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFile = vi.fn()
vi.mock('node:child_process', () => ({ execFile }))

const { realGh } = await import('../../src/modules/runs/pr-poller.js')

beforeEach(() => {
  execFile.mockReset()
  execFile.mockImplementation((_cmd, _args, _opts, done) => done(null, '{}', ''))
})

type Row = { args: string[]; allowed: boolean }
const rows: Row[] = [
  { args: ['pr', 'view', '7', '--repo', 'o/p', '--json', 'state'], allowed: true },
  { args: ['pr', 'list', '--repo', 'o/p'], allowed: true },
  { args: ['pr', 'create', '--repo', 'o/p'], allowed: true },
  { args: ['pr', 'comment', '7', '--body', 'x'], allowed: false },
  { args: ['pr', 'review', '7', '--approve'], allowed: false },
  { args: ['api', 'repos/o/p/issues'], allowed: false },
  { args: ['issue', 'comment', '1'], allowed: false },
  { args: [], allowed: false },
]

describe('realGh', () => {
  it.each(rows)('args $args allowed: $allowed', async ({ args, allowed }) => {
    if (allowed) {
      await expect(realGh(args)).resolves.toMatchObject({ code: 0 })
      expect(execFile).toHaveBeenCalledOnce()
    } else {
      await expect(realGh(args)).rejects.toThrow(
        `the board does not run gh ${args[0] ?? ''} ${args[1] ?? ''}`,
      )
      expect(execFile).not.toHaveBeenCalled()
    }
  })
})
