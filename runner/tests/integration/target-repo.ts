import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const git = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, encoding: 'utf8' })

/** Commits made by the tests and by the fake agents need an identity on any machine. */
export function useTestGitIdentity(): void {
  for (const [key, value] of Object.entries({
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 't@example.com',
  })) {
    process.env[key] = value
  }
}

/** A bare remote and a clone of it with one commit on main: the shape of a target repository. */
export function targetRepository(): { remote: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'target-'))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  git(['init', '-q', '--bare', '-b', 'main', remote])
  git(['clone', '-q', remote, repo])
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src/retry.ts'), 'export const delays = []\n')
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'initial'], repo)
  git(['push', '-q', 'origin', 'HEAD:main'], repo)
  return { remote, repo }
}

/** Writes `files` (path → content) in `repo`, commits them and pushes the result to the remote's main. */
export function pushToMain(repo: string, files: Record<string, string>, message: string): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', message], repo)
  git(['push', '-q', 'origin', 'HEAD:main'], repo)
}
