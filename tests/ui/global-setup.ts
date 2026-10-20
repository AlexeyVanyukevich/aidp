import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import pg from 'pg'

const REPO = resolve(import.meta.dirname, '../..')
const PORT = 4131
const RUNNER_KEY = 'u'.repeat(40)
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

const PLAN = {
  summary: 'One step',
  confidence: 'high',
  steps: [{ title: 'Delays', requirements: ['R1'], files: ['src/retry.ts'] }],
  checks: [{ criterion: 'AC1', how: 'read the delays' }],
}
const BUILD = [
  { edit: 'src/retry.ts', content: 'export const delays = [1, 2, 4]\n' },
  { commit: 'back off' },
]
const PASS = {
  tool: 'save_report',
  args: {
    summary: 'Passed',
    criteria: [{ id: 'AC1', status: 'pass', evidence: 'src/retry.ts lists 1, 2 and 4' }],
  },
}
/** A builder that asks first, then builds once answered. */
const asking = (question: string, options: { id: string; label: string; impact?: string }[]) => ({
  planner: [[{ tool: 'save_plan', args: PLAN }]],
  builder: [
    [{ tool: 'request_approval', args: { question, options, recommendation: options.at(-1)!.id } }],
    BUILD,
  ],
  verifier: [[PASS]],
})
const SCRIPT = {
  // Slice 2's journeys pick their script by the task's title.
  byTitle: {
    'Ask about colours': asking('Which colour should the retry banner be?', [
      { id: 'red', label: 'red' },
      { id: 'blue', label: 'blue', impact: 'Matches the logo' },
    ]),
    'Ask about sizes': asking('Which size should the retry banner be?', [
      { id: 'small', label: 'small' },
      { id: 'large', label: 'large', impact: 'Readable at a glance' },
    ]),
    'Stop after the plan': {
      planner: [[{ tool: 'save_plan', args: { ...PLAN, confidence: 'medium' } }]],
      builder: [BUILD],
      verifier: [[PASS]],
    },
    'Push fails once': {
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [BUILD],
      verifier: [[PASS]],
    },
  },
  planner: [[{ tool: 'save_plan', args: PLAN }]],
  builder: [
    [
      { edit: 'src/retry.ts', content: 'export const delays = [1, 2, 4]\n' },
      { commit: 'back off' },
    ],
  ],
  verifier: [
    [
      {
        tool: 'save_report',
        args: {
          summary: 'Passed',
          criteria: [{ id: 'AC1', status: 'pass', evidence: 'src/retry.ts lists 1, 2 and 4' }],
        },
      },
    ],
  ],
}

const git = (args: string[], cwd?: string) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_IDENTITY } })

/** A target repository: `origin` is a local bare remote, `github` only satisfies registration. */
function targetRepository(root: string, name: string): string {
  const remote = join(root, `${name}.git`)
  const repo = join(root, name)
  git(['init', '-q', '--bare', '-b', 'main', remote])
  git(['clone', '-q', remote, repo])
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src/retry.ts'), 'export const delays = []\n')
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'initial'], repo)
  git(['push', '-q', 'origin', 'HEAD:main'], repo)
  git(['remote', 'add', 'github', `git@github.com:owner/${name}.git`], repo)
  return repo
}

/** The model the recorded stream names, priced with fixture numbers so the Cost tab has dollars. */
function fixtureModels(): string[] {
  const lines = readFileSync(join(REPO, 'runner/tests/fixtures/stream/plain.ndjson'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
  const result = lines
    .map((l) => JSON.parse(l) as { type: string; modelUsage?: Record<string, unknown> })
    .filter((l) => l.type === 'result')
    .at(-1)
  return Object.keys(result?.modelUsage ?? {})
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error('The server never answered /api/health')
}

function labelled(child: ChildProcess, label: string): ChildProcess {
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[${label}] ${chunk}`))
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[${label}] ${chunk}`))
  return child
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const db = await new PostgreSqlContainer('postgres:16-alpine').start()
  const databaseUrl = db.getConnectionUri()
  const root = mkdtempSync(join(tmpdir(), 'board-ui-'))
  const repoPath = targetRepository(root, 'pay')
  const opsPath = targetRepository(root, 'ops')
  const askPath = targetRepository(root, 'ask')
  const flakyPath = targetRepository(root, 'flaky')
  // This remote refuses the first push it receives, so a run blocks on it and resumes.
  const refuseOnce = join(root, 'flaky.git', 'hooks', 'pre-receive')
  writeFileSync(
    refuseOnce,
    '#!/bin/sh\n[ -f pushed-once ] && exit 0\ntouch pushed-once\necho "refused once" >&2\nexit 1\n',
  )
  chmodSync(refuseOnce, 0o755)
  const scriptPath = join(root, 'script.json')
  writeFileSync(scriptPath, JSON.stringify(SCRIPT))

  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    RUNNER_KEY,
    PORT: String(PORT),
    LOG_LEVEL: 'warn',
    PR_POLL_MS: '3600000',
  }
  const migrate = spawnSync('npx', ['tsx', 'server/src/db/migrate.ts'], {
    cwd: REPO,
    env,
    encoding: 'utf8',
  })
  if (migrate.status !== 0)
    throw new Error(`Migrations failed:\n${migrate.stdout}\n${migrate.stderr}`)
  const build = spawnSync('npm', ['run', '--workspace', 'web', 'build'], {
    cwd: REPO,
    encoding: 'utf8',
  })
  if (build.status !== 0)
    throw new Error(`The web app did not build:\n${build.stdout}\n${build.stderr}`)

  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  for (const model of fixtureModels()) {
    await client.query(
      'insert into prices (model, effective_from, input, output, cache_read, cache_write) values ($1, $2, 1, 5, 0.1, 2)',
      [model, '2026-01-01'],
    )
  }
  await client.end()

  const server = labelled(
    spawn('npx', ['tsx', 'server/src/server.ts'], { cwd: REPO, env }),
    'server',
  )
  await waitForHealth()
  const runner = labelled(
    spawn(join(REPO, 'runner/bin/board-cli'), ['daemon'], {
      cwd: REPO,
      env: {
        ...process.env,
        ...GIT_IDENTITY,
        RUNNER_KEY,
        BOARD_URL: `http://127.0.0.1:${PORT}`,
        RUNNER_ID: 'ui-runner',
        CLAUDE_BIN: join(REPO, 'runner/tests/fake/fake-claude'),
        GH_BIN: join(REPO, 'runner/tests/fake/fake-gh'),
        BOARD_HOME: join(root, 'home'),
        CLAIM_WAIT_MS: '1000',
        HEARTBEAT_MS: '1000',
        FAKE_CLAUDE_SCRIPT: scriptPath,
      },
    }),
    'runner',
  )

  writeFileSync(
    resolve(REPO, 'tests/ui/.runtime.json'),
    JSON.stringify({ baseURL: `http://127.0.0.1:${PORT}`, repoPath, opsPath, askPath, flakyPath }),
  )

  // The database stops last: a server still listening on it when it goes would die of the
  // closed connection, mid-teardown.
  const exited = (child: ChildProcess) =>
    child.exitCode !== null ? Promise.resolve() : new Promise((done) => child.once('exit', done))
  return async () => {
    runner.kill('SIGTERM')
    server.kill('SIGTERM')
    await Promise.all([exited(runner), exited(server)])
    await db.stop()
  }
}
