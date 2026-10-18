// One real task, end to end, against a throwaway repository: real claude, real gh, real
// tokens. Prints the pull request and what it cost. Run through `./run smoke`.
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
    test_command: 'test -f SMOKE.md',
  })
}
const task = await call<{ id: string; key: string }>('POST', '/api/projects/SMOKE/tasks', {
  title: `Smoke ${today}`,
  budget_usd: 2,
})
const spec = await call<{ id: string }>('POST', `/api/tasks/${task.id}/specs`, { body_md: SPEC })
await call('POST', `/api/specs/${spec.id}/approve`)
console.log(`${task.key} approved; waiting for the runner (up to 30 minutes)…`)

const deadline = Date.now() + 30 * 60_000
let state = 'ready'
while (Date.now() < deadline && !['review', 'failed', 'done'].includes(state)) {
  await new Promise((done) => setTimeout(done, 10_000))
  state = (await call<{ state: string }>('GET', `/api/tasks/${task.id}`)).state
  process.stdout.write(`  ${state}\n`)
}

const [run] = await call<{ pr_url: string | null; failure_reason: string | null }[]>(
  'GET',
  `/api/tasks/${task.id}/runs`,
)
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
process.exit(state === 'review' ? 0 : 1)
