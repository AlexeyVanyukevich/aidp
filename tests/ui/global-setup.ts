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
const FAIL = {
  tool: 'save_report',
  args: {
    summary: 'Failed',
    criteria: [{ id: 'AC1', status: 'fail', evidence: 'src/retry.ts does not list 1, 2 and 4' }],
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
/** What the fake helper saves, in the order its calls come. */
const SUGGEST = (args: Record<string, unknown>) => [{ tool: 'save_help_result', args }]
const EXPLAIN = [
  {
    tool: 'save_help_result',
    args: {
      asked: 'Which colour the retry banner should be.',
      matters: 'It is the first thing a customer sees when a delivery fails.',
      leads_to: 'Red is loud; blue matches the logo.',
    },
  },
]
const colours = asking('Which colour should the retry banner be?', [
  { id: 'red', label: 'red' },
  { id: 'blue', label: 'blue', impact: 'Matches the logo' },
])
/** The spec the spec-writer saves: the same that the other journeys approve. */
const DRAFTED = `## Goal
Failed deliveries back off.

## Requirements
1. R1 – Retries back off

## Acceptance criteria
- AC1 (R1): Given a failure Then it retries after 1, 2 and 4 seconds

## Open questions
`
const SAVE = { tool: 'save_spec', args: { body_md: DRAFTED } }
/** A spec-writer that asks a batch of two, then saves once answered. */
const drafting = {
  'spec-writer': [
    [
      {
        tool: 'request_approval',
        args: {
          kind: 'questions',
          questions: [
            {
              question: 'How many retries?',
              options: [
                { id: 'three', label: 'Three' },
                { id: 'five', label: 'Five', impact: 'Slower, but surer' },
              ],
              recommendation: 'three',
            },
            { question: 'Which errors should retry?' },
          ],
        },
      },
    ],
    [SAVE],
  ],
  planner: [[{ tool: 'save_plan', args: PLAN }]],
  builder: [BUILD],
  verifier: [[PASS]],
}
/** The title-writer's suggestions: the first, and the second a later Rephrase title brings. */
const SUGGEST_FIRST = {
  tool: 'suggest_title',
  args: {
    title: 'Back off failed webhook deliveries',
    reason: 'Names the delivery retry in src/retry.ts',
  },
}
const SUGGEST_SECOND = {
  tool: 'suggest_title',
  args: { title: 'Retry webhook deliveries with growing delays', reason: 'Names the delay list' },
}
/** The rephraser's suggestion for a description. */
const SAVE_DESCRIPTION = {
  tool: 'save_suggestion',
  args: {
    body_md:
      'Retry failed webhook deliveries with delays of 1, 2 and 4 seconds (src/retry.ts). Unsure: whether a 429 counts as a failure.',
  },
}
const SCRIPT = {
  // Slice 2's and slice 3's journeys pick their script by the task's title.
  byTitle: {
    // A title run reads the task's current title, so the typed variants carry the fragment too.
    'Suggest one': { 'title-writer': [[SUGGEST_FIRST]] },
    'Suggest slowly': { 'title-writer': [[{ sleep: 6_000 }, SUGGEST_FIRST]] },
    'Suggest twice': { 'title-writer': [[SUGGEST_FIRST], [SUGGEST_SECOND]] },
    'Suggest nothing': { 'title-writer': [[]] },
    // A rephrase run reads the task's title from the handoff, as a title run does.
    'Rephrase one': { rephraser: [[SAVE_DESCRIPTION]] },
    'Rephrase slowly': { rephraser: [[{ sleep: 6_000 }, SAVE_DESCRIPTION]] },
    'Rephrase nothing': { rephraser: [[]] },
    'Draft a retry spec': drafting,
    'Help with colours': {
      ...colours,
      helper: [
        SUGGEST({
          option_id: 'blue',
          text: 'Go with blue.',
          reasoning: 'Matches the logo.',
          unsure: 'Whether print differs.',
        }),
        EXPLAIN,
        SUGGEST({
          option_id: 'blue',
          text: 'Go with blue, but check print.',
          reasoning: 'Second opinion.',
          unsure: 'Whether print differs.',
        }),
      ],
    },
    'Help that fails': { ...colours, helper: [[]] },
    // Decision helps: one script per press, in order.
    'Help at Spec review': {
      helper: [
        SUGGEST({
          verdict: 'changes',
          findings: [{ kind: 'missing', where: 'R1', text: 'No retry limit' }],
          unsure: 'Whether 429 counts.',
        }),
        SUGGEST({
          changes: 'Retries back off.',
          requirements: 'Delays of 1, 2 and 4 seconds.',
          left_out: 'A retry limit.',
        }),
      ],
    },
    // Not "Help at Spec review that fails": a title takes the first key it contains.
    'A spec review that fails': { helper: [[]] },
    'Help at a stop': {
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [1, 2, 3].map((n) => [
        { edit: 'src/retry.ts', content: `export const delays = [${n}]\n` },
        { commit: `attempt ${n}` },
      ]),
      verifier: [1, 2, 3].map(() => [FAIL]),
      helper: [
        SUGGEST({
          why_stopped: 'The verifier failed AC1 three times.',
          action: 'rerun_keep',
          reasoning: 'The plan was sound.',
          unsure: 'Whether the delays are right.',
        }),
        SUGGEST({
          checked_against: 'approved_spec',
          produced: 'Three commits on a branch.',
          unfinished: [{ where: 'src/retry.ts', text: 'Delays are not 1, 2, 4.' }],
          unsure: 'Whether the branch was pushed.',
        }),
      ],
    },
    // A help that succeeds at each decision, whose buttons are read before and after.
    'Buttons at Spec review': {
      helper: [SUGGEST({ verdict: 'nothing_to_change', findings: [], unsure: 'Nothing.' })],
    },
    'Buttons at a stop': {
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [1, 2, 3].map((n) => [
        { edit: 'src/retry.ts', content: `export const delays = [${n}]\n` },
        { commit: `attempt ${n}` },
      ]),
      verifier: [1, 2, 3].map(() => [FAIL]),
      helper: [
        SUGGEST({
          why_stopped: 'The verifier failed AC1 three times.',
          action: 'rerun_again',
          reasoning: 'The plan missed the delays.',
          unsure: 'Whether the spec is clear.',
        }),
      ],
    },
    'Buttons at a block': {
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [BUILD],
      verifier: [[PASS]],
      helper: [
        SUGGEST({
          why_stopped: 'The remote refused the push.',
          action: 'cancel',
          reasoning: 'The remote refuses every push.',
          unsure: 'Whether the remote will change.',
        }),
      ],
    },
    'Help with a batch': {
      ...drafting,
      helper: [
        SUGGEST({
          text: 'Only server errors.',
          reasoning: 'Client errors will not change on retry.',
          unsure: 'Whether 429 counts.',
        }),
        SUGGEST({
          option_id: 'five',
          text: 'Five, to be safe.',
          reasoning: 'Deliveries are cheap.',
          unsure: 'The load on the receiver.',
        }),
      ],
    },
    'Answer by keyboard': drafting,
    'Redraft a spec': { 'spec-writer': [[SAVE]] },
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
    // A confident plan whose builds are never verified: the run fails with an accepted plan.
    'Fail after a confident plan': {
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [1, 2, 3].map((n) => [
        { edit: 'src/retry.ts', content: `export const delays = [${n}]\n` },
        { commit: `attempt ${n}` },
      ]),
      verifier: [1, 2, 3].map(() => [FAIL]),
    },
    // Cancelled at the plan gate: a plan the owner never approved, so nothing to keep.
    'Cancel at the plan gate': {
      planner: [[{ tool: 'save_plan', args: { ...PLAN, confidence: 'medium' } }]],
      builder: [BUILD],
      verifier: [[PASS]],
    },
    // A spec with an owner check: the verifier passes AC1 and leaves AC2 to the owner.
    'Hand check at the PR': {
      planner: [
        [
          {
            tool: 'save_plan',
            args: {
              ...PLAN,
              checks: [
                { criterion: 'AC1', how: 'read the delays' },
                { criterion: 'AC2', how: 'the owner reads the banner in a browser' },
              ],
            },
          },
        ],
      ],
      builder: [BUILD],
      verifier: [
        [
          {
            tool: 'save_report',
            args: {
              summary: 'One is yours',
              criteria: [
                { id: 'AC1', status: 'pass', evidence: 'src/retry.ts lists 1, 2 and 4' },
                { id: 'AC2', status: 'owner', evidence: 'the banner is not in the diff to run' },
              ],
            },
          },
        ],
      ],
    },
    // The owner drops AC2 in words at the plan gate; the revised plan quotes it, and the
    // verifier gives AC2 `withdrawn`.
    'Withdraw a criterion': {
      planner: [
        [
          {
            tool: 'save_plan',
            args: {
              ...PLAN,
              confidence: 'medium',
              checks: [
                { criterion: 'AC1', how: 'read the delays' },
                { criterion: 'AC2', how: 'read the banner' },
              ],
            },
          },
        ],
        [
          {
            tool: 'save_plan',
            args: {
              ...PLAN,
              confidence: 'medium',
              withdrawn: [{ criterion: 'AC2', answer: 'Drop AC2: the banner is gone.' }],
            },
          },
        ],
      ],
      builder: [BUILD],
      verifier: [
        [
          {
            tool: 'save_report',
            args: {
              summary: 'One is withdrawn',
              criteria: [
                { id: 'AC1', status: 'pass', evidence: 'src/retry.ts lists 1, 2 and 4' },
                {
                  id: 'AC2',
                  status: 'withdrawn',
                  evidence: 'the owner’s answer drops the banner',
                },
              ],
            },
          },
        ],
      ],
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
  // The planner's, builder's and verifier's streams, and the spec-writer's on Opus.
  const models = ['plain', 'spec-plain'].flatMap((fixture) => {
    const lines = readFileSync(join(REPO, `runner/tests/fixtures/stream/${fixture}.ndjson`), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
    const result = lines
      .map((l) => JSON.parse(l) as { type: string; modelUsage?: Record<string, unknown> })
      .filter((l) => l.type === 'result')
      .at(-1)
    return Object.keys(result?.modelUsage ?? {})
  })
  return [...new Set(models)]
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
  const draftPath = targetRepository(root, 'draft')
  // This remote refuses the first push it receives, so a run blocks on it and resumes.
  const refuseOnce = join(root, 'flaky.git', 'hooks', 'pre-receive')
  writeFileSync(
    refuseOnce,
    '#!/bin/sh\n[ -f pushed-once ] && exit 0\ntouch pushed-once\necho "refused once" >&2\nexit 1\n',
  )
  chmodSync(refuseOnce, 0o755)
  // This one refuses every push, so a run stays Blocked whichever journey reaches it first.
  const stuckPath = targetRepository(root, 'stuck')
  const refuseAll = join(root, 'stuck.git', 'hooks', 'pre-receive')
  writeFileSync(refuseAll, '#!/bin/sh\necho "refused" >&2\nexit 1\n')
  chmodSync(refuseAll, 0o755)
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
    JSON.stringify({
      baseURL: `http://127.0.0.1:${PORT}`,
      repoPath,
      opsPath,
      askPath,
      flakyPath,
      stuckPath,
      draftPath,
    }),
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
