import { describe, expect, it } from 'vitest'
import type { Exec } from '../../src/exec.js'
import { Git, GitError } from '../../src/git.js'

type Row = { args: string[]; allowed: boolean }
const rows: Row[] = [
  { args: ['pr', 'view', '7', '--repo', 'o/p'], allowed: true },
  { args: ['pr', 'list', '--repo', 'o/p'], allowed: true },
  { args: ['pr', 'create', '--repo', 'o/p'], allowed: true },
  { args: ['pr', 'comment', '7'], allowed: false },
  { args: ['pr', 'review', '7'], allowed: false },
  { args: ['api', 'repos/o/p'], allowed: false },
  { args: ['issue', 'comment', '1'], allowed: false },
]

describe('Git.run on the gh binary', () => {
  it.each(rows)('args $args allowed: $allowed', async ({ args, allowed }) => {
    const calls: string[][] = []
    const exec: Exec = async (_cmd, a) => {
      calls.push(a)
      return { code: 0, stdout: '', stderr: '' }
    }
    const git = new Git(exec, 'gh')
    const run = (git as unknown as { run(cmd: string, args: string[]): Promise<string> }).run.bind(
      git,
    )
    if (allowed) {
      await run('gh', args)
      expect(calls).toHaveLength(1)
    } else {
      const error = await run('gh', args).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(GitError)
      expect((error as GitError).message).toContain(
        `the board does not run gh ${args[0]} ${args[1]}`,
      )
      expect(calls).toHaveLength(0)
    }
  })
})
