import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRepoInspector } from '../../src/modules/projects/repo-inspector.js'

function repoWithRemote(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-repo-'))
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url])
  return dir
}

describe('createRepoInspector', () => {
  const inspector = createRepoInspector()

  it('reads a repository and its remotes', async () => {
    const dir = repoWithRemote('git@github.com:owner/pay.git')
    expect(await inspector.inspect(dir)).toEqual({
      isGitRepo: true,
      remotes: ['git@github.com:owner/pay.git'],
    })
  })

  it('says a plain directory is not a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-plain-'))
    expect((await inspector.inspect(dir)).isGitRepo).toBe(false)
  })

  it('says a path that does not exist is not a repository', async () => {
    expect((await inspector.inspect('/does/not/exist')).isGitRepo).toBe(false)
  })

  it.each([
    ['a command on PATH', 'git status', true],
    ['a command that does not exist', 'definitely-not-a-command --flag', false],
    ['an empty command', '   ', false],
  ])('commandExists: %s', async (_name, command, expected) => {
    expect(await inspector.commandExists(command, tmpdir())).toBe(expected)
  })
})
