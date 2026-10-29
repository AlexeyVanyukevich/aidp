import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decide } from '../../src/hooks/guard.js'
import { readMigrationSiblings } from '../../src/hooks/migration-siblings.js'

const DIR = 'server/src/db/migrations'
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })

/** A repository whose `origin/main` holds `onOrigin`, and a clone whose directory holds `inTree`. */
function setup(onOrigin: string[], inTree: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'siblings-'))
  const origin = join(root, 'origin')
  mkdirSync(join(origin, DIR), { recursive: true })
  for (const f of onOrigin) writeFileSync(join(origin, DIR, f), '')
  writeFileSync(join(origin, 'README'), '')
  git(origin, 'init', '-q', '-b', 'main')
  git(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
  git(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x')
  const work = join(root, 'work')
  git(root, 'clone', '-q', origin, work)
  git(work, 'rm', '-rq', '--cached', '.')
  mkdirSync(join(work, DIR), { recursive: true })
  for (const f of onOrigin) execFileSync('rm', ['-f', join(work, DIR, f)])
  for (const f of inTree) writeFileSync(join(work, DIR, f), '')
  return work
}

describe('reading a migration directory’s siblings', () => {
  it('joins the worktree with origin/<base>, each name once', () => {
    const work = setup(['004_setup_command.ts', '003_a.ts'], ['001_a.ts', '002_a.ts', '003_a.ts'])
    expect(readMigrationSiblings(work, 'main', DIR).sort()).toEqual([
      '001_a.ts',
      '002_a.ts',
      '003_a.ts',
      '004_setup_command.ts',
    ])
  })

  it('makes the guard name a sibling only origin holds', () => {
    const work = setup(['004_setup_command.ts'], ['001_a.ts', '002_a.ts', '003_a.ts'])
    const verdict = decide(
      { tool_name: 'Write', tool_input: { file_path: `${DIR}/004_helps.ts` } },
      {
        phase: 'build',
        allowedFiles: [`${DIR}/004_helps.ts`],
        paused: false,
        cwd: work,
        exists: () => false,
        migrationSiblings: (dir) => readMigrationSiblings(work, 'main', dir),
      },
    )
    expect(!verdict.allow && verdict.reason).toContain('004_setup_command')
  })

  it('compares with the worktree alone when origin/<base> does not resolve, and fetches nothing', () => {
    const work = setup([], ['006_project_links.ts'])
    const calls: string[][] = []
    const run = (cwd: string, args: string[]) => {
      calls.push(args)
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' })
    }
    expect(readMigrationSiblings(work, 'nope', DIR, run)).toEqual(['006_project_links.ts'])
    expect(calls.flat()).not.toContain('fetch')
    expect(calls.length).toBeGreaterThan(0)
  })

  it('compares with origin/<base> alone when the worktree directory is missing', () => {
    const work = setup(['004_setup_command.ts'], [])
    execFileSync('rm', ['-rf', join(work, 'server')])
    expect(readMigrationSiblings(work, 'main', DIR)).toEqual(['004_setup_command.ts'])
  })

  it('lists nothing when neither source does', () => {
    const work = setup([], [])
    expect(readMigrationSiblings(work, null, DIR)).toEqual([])
  })
})
