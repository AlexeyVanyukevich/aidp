import { describe, expect, it } from 'vitest'
import type { Exec } from '../../src/exec.js'
import { Git } from '../../src/git.js'

/** An exec whose commands take a few milliseconds each, counting how many run at once. */
function slowExec(fail: (args: string[]) => boolean = () => false) {
  let active = 0
  let most = 0
  const exec: Exec = async (_cmd, args) => {
    active++
    most = Math.max(most, active)
    await new Promise((done) => setTimeout(done, 5))
    active--
    return fail(args)
      ? { code: 1, stdout: '', stderr: 'cannot lock ref' }
      : { code: 0, stdout: '', stderr: '' }
  }
  return { exec, most: () => most }
}

// Two lanes, each with its own repository-level step, started together.
const rows: { name: string; steps: (git: Git) => Promise<void>[]; atOnce: number }[] = [
  {
    name: "a title run's checkout beside a delivery run's, in one repository",
    steps: (git) => [
      git.prepareDetachedWorktree('/repo', 'main', '/wt/title'),
      git.prepareWorktree('/repo', 'main', 'board/T-1-r1', '/wt/delivery'),
    ],
    atOnce: 1,
  },
  {
    name: "a title run's checkout beside a base refresh",
    steps: (git) => [
      git.prepareDetachedWorktree('/repo', 'main', '/wt/title'),
      git.fetchBase('/repo', 'main'),
    ],
    atOnce: 1,
  },
  {
    name: "a title run's cleanup beside a delivery run's checkout",
    steps: (git) => [
      git.removeWorktree('/repo', '/wt/title'),
      git.prepareWorktree('/repo', 'main', 'board/T-1-r1', '/wt/delivery'),
    ],
    atOnce: 1,
  },
  {
    name: "a prune beside a title run's checkout",
    steps: (git) => [
      git.pruneWorktrees('/repo'),
      git.prepareDetachedWorktree('/repo', 'main', '/wt/title'),
    ],
    atOnce: 1,
  },
  {
    name: 'a branch deletion beside a base refresh',
    steps: (git) => [git.deleteBranch('/repo', 'board/T-1-r1'), git.fetchBase('/repo', 'main')],
    atOnce: 1,
  },
  {
    name: 'one repository spelt two ways',
    steps: (git) => [git.fetchBase('/repo', 'main'), git.fetchBase('/repo/', 'main')],
    atOnce: 1,
  },
  {
    name: 'two different repositories',
    steps: (git) => [
      git.prepareDetachedWorktree('/repo-a', 'main', '/wt/title'),
      git.prepareWorktree('/repo-b', 'main', 'board/T-1-r1', '/wt/delivery'),
    ],
    atOnce: 2,
  },
]

describe("repository-level git commands, from the daemon's two lanes", () => {
  it.each(rows)('$name: at most $atOnce at once', async ({ steps, atOnce }) => {
    const { exec, most } = slowExec()
    await Promise.all(steps(new Git(exec, 'gh')))
    expect(most()).toBe(atOnce)
  })

  it('a command that fails does not hold up the next one in its repository', async () => {
    const { exec } = slowExec((args) => args.includes('fetch'))
    const git = new Git(exec, 'gh')
    const failed = git.fetchBase('/repo', 'main')
    const next = git.removeWorktree('/repo', '/wt/title')
    await expect(failed).rejects.toThrow('cannot lock ref')
    await expect(next).resolves.toBeUndefined()
  })
})
