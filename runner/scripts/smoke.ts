// One real task, end to end, against a throwaway repository: real claude, real gh, real
// tokens. Prints the pull request and what it cost. Run through `./run smoke`.
//
// With `--draft` (slice 3), the spec is not written here: the task carries a description that
// leaves two questions open, the spec-writer drafts it, and the owner answers, reviews and
// approves on the board while this waits.
import { execFileSync } from 'node:child_process'
import { coAuthored, LOG_FORMAT } from './smoke-trailers.js'

const board = (process.env.BOARD_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '')
const repoPath = process.env.SMOKE_REPO_PATH
const githubRepo = process.env.SMOKE_GITHUB_REPO
if (repoPath === undefined || githubRepo === undefined)
  throw new Error('SMOKE_REPO_PATH and SMOKE_GITHUB_REPO are required')

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${board}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`)
  return JSON.parse(text) as T
}

const today = new Date().toISOString().slice(0, 10)
const SPEC = `## Goal
The repository records that the board's smoke run reached it.

## Requirements
1. R1 – A file SMOKE.md exists at the repository root
2. R2 – SMOKE.md contains the line "smoke ${today}"

## Acceptance criteria
- AC1 (R1): Given the branch When listing the root Then SMOKE.md is there
- AC2 (R2): Given SMOKE.md When reading it Then one line reads exactly "smoke ${today}"

## Out of scope
Any other file.

## Open questions
`

const projects = await call<{ key: string }[]>('GET', '/api/projects')
if (!projects.some((p) => p.key === 'SMOKE')) {
  await call('POST', '/api/projects', {
    key: 'SMOKE',
    name: 'Smoke',
    repo_path: repoPath,
    github_repo: githubRepo,
    base_branch: 'main',
  })
  const [fallback] = await call<{ id: string }[]>('GET', '/api/projects/SMOKE/test-commands')
  await call('PATCH', `/api/projects/SMOKE/test-commands/${fallback!.id}`, {
    command: 'test -f SMOKE.md',
  })
}
const drafted = process.argv.includes('--draft')
// Two things a spec has to settle are left open on purpose: the file's line, and its format.
const DESCRIPTION = `Record in the repository that the board's smoke run of ${today} reached it, in a file at the root. Which file, and what its line says, are not decided.`
const task = await call<{ id: string; key: string }>('POST', '/api/projects/SMOKE/tasks', {
  title: drafted ? `Drafted smoke ${today}` : `Smoke ${today}`,
  budget_usd: 2,
  ...(drafted ? { description_md: DESCRIPTION } : {}),
})
if (drafted) {
  await call('POST', `/api/tasks/${task.id}/actions/draft-spec`)
  console.log(`${task.key} is drafting. Answer its questions, review and approve the spec at:`)
  console.log(`  ${board}/p/SMOKE/${task.id}`)
  console.log('Waiting for a pull request (up to 60 minutes)…')
} else {
  const spec = await call<{ id: string }>('POST', `/api/tasks/${task.id}/specs`, { body_md: SPEC })
  await call('POST', `/api/specs/${spec.id}/approve`)
  console.log(`${task.key} approved; waiting for the runner (up to 30 minutes)…`)
}

const deadline = Date.now() + (drafted ? 60 : 30) * 60_000
let state = drafted ? 'spec_draft' : 'ready'
while (Date.now() < deadline && !['review', 'failed', 'done'].includes(state)) {
  await new Promise((done) => setTimeout(done, 10_000))
  const next = (await call<{ state: string }>('GET', `/api/tasks/${task.id}`)).state
  if (next !== state) process.stdout.write(`  ${next}\n`)
  state = next
}

// Newest first: the delivery run, then its drafts.
const runs = await call<
  {
    kind: string
    number: number
    branch: string | null
    pr_url: string | null
    failure_reason: string | null
  }[]
>('GET', `/api/tasks/${task.id}/runs`)
const run = runs.find((r) => r.kind === 'delivery')
if (drafted)
  console.log(
    `drafts: ${runs.filter((r) => r.kind === 'spec').length}, versions saved by hand or by the spec-writer:`,
  )
if (drafted)
  for (const version of await call<{ version: number; status: string }[]>(
    'GET',
    `/api/tasks/${task.id}/specs`,
  ))
    console.log(`  v${version.version} ${version.status}`)
const costs = await call<{
  totals: { usd: number }
  byPhase: { name: string; usd: number; reportedUsd: number | null; flagged: boolean }[]
  missingPrices: string[]
}>('GET', `/api/tasks/${task.id}/costs`)
console.log(`state: ${state}`)
console.log(
  `pull request: ${run?.pr_url ?? 'none'}${run?.failure_reason ? ` (${run.failure_reason})` : ''}`,
)
console.log(`cost: $${costs.totals.usd.toFixed(4)}`)
for (const phase of costs.byPhase) {
  console.log(
    `  ${phase.name}: $${phase.usd.toFixed(4)} computed, $${phase.reportedUsd?.toFixed(4) ?? '—'} reported${phase.flagged ? '  ⚠ over 2% apart' : ''}`,
  )
}
if (costs.missingPrices.length > 0)
  console.log(`no price for: ${costs.missingPrices.join(', ')} — ./run price:set`)

// Every commit the branch adds to the base, not only the last: a run's commits follow the
// repository's convention, which has no Co-Authored-By trailer.
let trailers = 0
if (run?.branch != null) {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' })
  git('fetch', 'origin', 'main', run.branch)
  const log = git('log', `--format=${LOG_FORMAT}`, `origin/main..origin/${run.branch}`)
  const flagged = coAuthored(log)
  console.log(
    `commits on ${run.branch}: ${log.split('\x1e').filter((r) => r.trim() !== '').length}`,
  )
  for (const sha of flagged) console.error(`commit ${sha} carries a Co-Authored-By trailer`)
  trailers = flagged.length
}
process.exit(state === 'review' && trailers === 0 ? 0 : 1)
