# Slice 1 — one task, start to pull request — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner registers a target repository, writes a task and its spec on the board,
approves the spec, and gets a pull request whose every step and its cost are on the card.

**Architecture:** Three npm workspaces. `server/` is one Fastify process over PostgreSQL: the
REST API under `/api`, the board MCP server at `/mcp`, server-sent events, and a PR poller.
`runner/` is `board-cli`: a daemon that claims runs, drives Plan → Build → Verify as one
`claude -p` per phase in a git worktree, and the `event` and `guard` hook commands. `web/` is a
Vite + React single-page app the server serves from the same origin.

**Tech Stack:** Node 24, TypeScript 7, Fastify 5, TypeBox (`typebox`), Kysely + `pg`,
PostgreSQL 16, `@modelcontextprotocol/sdk` 1.32 with `zod` 4, Vitest 4 + Testcontainers 12,
React 19, React Router 7, TanStack Query 5, Vite 8, Playwright 1.62, the `charter` package at
`v3.3.0`.

**Spec:** [`docs/superpowers/specs/2026-10-10-mvp-design.md`](../specs/2026-10-10-mvp-design.md),
§13 "Slice 1". Read it before starting; this plan argues from it and does not restate its
reasons.

## Global Constraints

- Node `>=24.0.0`; every workspace's `package.json` says so in `engines`.
- The kit: `"charter": "github:AlexeyVanyukevich/charter#v3.3.0"`. The root `CLAUDE.md` is the
  one `@` import, `core`'s; every other rule loads by path from the mirror `charter sync`
  writes. `charter.json` records each workspace's modules, written by `npx --no charter init`:
  `server` takes `backend typescript node vitest`, `runner` takes `typescript node vitest`,
  `web` takes `frontend typescript react vitest playwright`, and the root takes
  `frontend playwright` for `tests/ui/`. No workspace has a `CLAUDE.md` of its own; `init`
  writes each one's `.claude/settings.json` instead.
- The web app meets WCAG 2.2 AA (spec §8, Accessibility). Its widgets come from the zellige kit,
  `"@zellige/core": "github:AlexeyVanyukevich/zellige-core#v0.1.1"` and
  `"@zellige/react": "github:AlexeyVanyukevich/zellige-react#v0.1.0"`, which the root
  `CLAUDE.md` names. `web/` lints with oxlint and the kit's `react` and `vitest` configs. Journeys
  find elements by role and accessible name — never by test id or CSS class — and scan every
  state they reach with axe-core.
- Backend workspaces (`server/`, `runner/`) resolve `NodeNext`: every relative import ends in
  `.js`. `web/` resolves as a bundler: no extension.
- TypeBox comes from `typebox`, never `@sinclair/typebox`. No `any` in hand-written code;
  `Kysely<any>` only in migrations.
- Every error response is `{ "error": "<code>", "message": "…", "details"?: {} }` with the
  kit's codes. Every request body schema has `additionalProperties: false`.
- Commits: Conventional Commits, subject line only, 72 characters at most, no body, no
  `Co-Authored-By` trailer. The kit's `commit-msg` hook, which `./run` installs, refuses
  anything else. Scopes: `db`, `server`, `mcp`, `runner`, `web`, `ui`, `deps`. Work on branch
  `feat/slice-1-task-to-pr`; merge by rebase.
- Tests first for every task. One behaviour's cases in an `it.each` table. Clock and network
  injected. Database tests against a real PostgreSQL from Testcontainers.
- The server binds `127.0.0.1` only. Writes with a foreign `Origin`, and any request whose
  `Host` is not in `ALLOWED_HOSTS` (default `localhost,127.0.0.1`), answer
  `403 forbidden_origin`.
- Every `claude -p` call carries `--setting-sources project`, `--strict-mcp-config` and
  `--include-partial-messages --output-format stream-json --verbose`. No phase uses
  `bypassPermissions`. Agents never push.
- Ports: server `4100`, Vite `5174`, compose PostgreSQL on host port `5435`, database `board`.

## Decisions this plan takes inside the spec

These are not in the spec and a reviewer should know they were made here:

- REST paths are the spec's paths under an `/api` prefix (`/api/projects`, `/api/runner/claim`),
  so the single-page app can fall back to `index.html` for every other path.
- The runner reports phase and run state **as events** (`phase_start`, `phase_end`, `run_end`)
  through `POST /api/runner/events`; the server derives `phases` rows and task moves from them.
  That keeps the runner surface the spec lists — claim, heartbeat, events — and adds only
  `POST /api/runner/runs/{id}/tokens` (a token per process launch) and
  `POST /api/runner/tokens/retire`.
- Cancel reaches the runner in the heartbeat response, `{ "cancel": [runId, …] }`.
- `artifacts` gains `phase_id` and `data jsonb`: a plan and a verify report are stored both as
  rendered Markdown and as the structure the runner and the web app read.
- The runner keeps its own copy of the wire types (`runner/src/contract.ts`). The scenario
  tests in Task 21 run the runner against the real server, which is what catches drift.
- Phase prompts require `run_in_background: false` on every `Agent` call: a background
  subagent returns no usage (recorded 2026-10-11), and its tokens would land in the
  unattributed line instead of under its name.
- The worktree is removed when the run ends, whatever the outcome. The spec keeps it until
  Done or Failed so a paused run can resume; nothing pauses before slice 2, which keeps the
  worktrees of paused runs.
- Two known gaps are recorded in `docs/backlog.md` by Task 27 rather than closed here: no
  lost-runner sweeper (slice 2), and cache writes priced at one rate.
- `modules/runner/`, `modules/mcp/` and `modules/stream/` keep singular names. They are named
  for the interface they serve, not for an entity, so the layout rule's plural directory has
  nothing to pluralise.
- The runner takes `typescript node vitest` and not the `backend` domain: it serves no HTTP and
  has no `src/modules/`, and under the kit's modules it no longer needs `backend` to get the
  `NodeNext` rule.
- The root is a recorded workspace with `frontend playwright` only, so the journey rules load on
  `tests/ui/`, where the journeys drive the whole product. `frontend`'s `**/*.css` rule then
  loads twice on the web app's stylesheets, once per mirror; nothing else overlaps.
- Every drag has a button in the card's dialog: Move up and Move down reorder within the
  column, Mark done moves a Review card to Done. They patch the same fields a drop does.
- The open card announces every change of its own state, whoever made it; the board announces
  nothing the runner does. The page behind a modal dialog is inert, and announcing every card
  the runner moves would never stop during a run.
- The web app owns every word it shows for an error, chosen by code and field
  (`web/src/errors.ts`), because the kit's HTTP rule keeps the server's `message` from users.
- The board's columns do not scroll inside a box: a scrolling box with nothing focusable in it
  fails axe's `scrollable-region-focusable` (WCAG 2.1.1), so the page scrolls instead.
- Web unit tests live in `web/tests/unit/`, as the kit's testing rule places them.
- `@vitejs/plugin-react` is `^6.1.2`, the major the kit's React binding builds with on Vite 8.

## Review Focus

Inputs the spec implies and no feature test would otherwise exercise, most likely first. Each
has its test in the task that owns the code.

1. **A spec written on another machine** — CRLF line endings, `## acceptance criteria` in lower
   case, `*` bullets, an en dash or a colon after `R1` — lints exactly like the template.
   (Task 5)
2. **`claude` prints a line that is not JSON** on stdout (a warning, a blank line) — the phase
   continues and the line is kept in the run directory log, not a crash. (Task 18)
3. **The server is down while hooks and the runner report**, then comes back — the buffered
   events replay once; a replayed event id is not counted twice. (Task 15, Task 11)
4. **Two tabs, one stale** — approving a version already approved or superseded, or a drop on
   a card the runner moved since, answers `409 conflict`, never `500`. (Task 10, Task 9)
5. **A test command that prints megabytes or never ends** — its output is kept to the last
   64 KiB and it is killed after `TEST_TIMEOUT_MS` (default 15 minutes); the run continues to
   Verify with what it has. (Task 19)

---

## File structure

```
ai-task-board/
  package.json  CLAUDE.md  CONTRIBUTING.md  README.md  run  docker-compose.yml  .env.example
  .gitignore  .prettierignore  playwright.config.ts  charter.json  .claude/settings.json
  server/
    package.json  tsconfig.json  vitest.config.ts  .claude/settings.json
    scripts/set-price.ts                      price rows from the command line
    src/
      server.ts  app.ts  config.ts
      db/        client.ts  migrate.ts  schema.ts  migrations/{index,001_initial}.ts
      shared/    vocabulary.ts  errors.ts  hosts.ts  bus.ts  tokens.ts  schemas.ts
      modules/
        projects/  project.{routes,schemas,service,repository}.ts  repo-inspector.ts
        tasks/     task.{routes,schemas,service,repository}.ts  task.moves.ts  task.actions.ts  transitions.ts
        specs/     spec.{routes,schemas,service,repository}.ts  spec-parser.ts
        runs/      run.{routes,service,repository}.ts  pr-poller.ts  pr-files.ts
        runner/    runner.{routes,schemas,service}.ts  event-effects.ts
        costs/     cost.{routes,service}.ts  pricing.ts  summarize.ts
        mcp/       mcp.routes.ts  board-tools.ts  plan-check.ts
        stream/    stream.routes.ts
    tests/unit/  tests/integration/  (global-setup.ts, helpers.ts, fixtures.ts)
  runner/
    package.json  tsconfig.json  vitest.config.ts  .claude/settings.json
    bin/board-cli                             runs src/cli.ts through tsx
    scripts/record-stream.sh  scripts/smoke.ts
    src/
      cli.ts  daemon.ts  delivery.ts  config.ts  contract.ts  api.ts  sink.ts  exec.ts  self.ts
      git.ts  test-command.ts
      stream/normalize.ts
      hooks/hook-event.ts  hooks/guard.ts
      phases/agents.ts  phases/handoff.ts  phases/claude-args.ts  phases/run-dir.ts  phases/phase.ts
    tests/unit/  tests/integration/  (target-repo.ts)
    tests/fixtures/stream/{plain,subagent}.ndjson   recorded, never hand-written
    tests/fake/{fake-claude, fake-claude.ts, fake-gh, stream-replay.ts}
  web/
    package.json  tsconfig.json  vite.config.ts  index.html  .oxlintrc.json  .claude/settings.json
    src/main.tsx  App.tsx  api.ts  types.ts  stream.ts  errors.ts  page.ts  Loaded.tsx  styles.css
    src/routes/{Projects,Board}.tsx
    src/board/{columns.ts,TaskCardView.tsx,board.css}
    src/card/{CardDrawer,SpecTab,PlanTab,TimelineTab,CostTab,PrTab}.tsx  lint.ts  timeline.ts  format.ts  card.css
    tests/unit/*.test.ts
  tests/ui/{global-setup.ts,helpers.ts,task-to-pr.spec.ts,keyboard.spec.ts}
  docs/architecture.md  docs/backlog.md
```

Each module follows the kit's layout. The pure cores — `transitions.ts`, `spec-parser.ts`,
`pricing.ts`, `summarize.ts`, `plan-check.ts`, `event-effects.ts`, and in the runner
`normalize.ts`, `guard.ts`, `handoff.ts`, `claude-args.ts` — import nothing from `db/`, and
`grep -l "db/" <file>` printing nothing is part of their task's verification.

---

## Phase A — the server's foundation

### Task 1: Repository skeleton on the kit, and the server's configuration

**Files:**

- Create: `package.json`, `CLAUDE.md`, `CONTRIBUTING.md`, `.env.example`, `.prettierignore`,
  `docker-compose.yml`, `run`
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`,
  `server/src/config.ts`
- Create through `charter init`: `charter.json`, `.claude/settings.json`,
  `server/.claude/settings.json`; Modify: `.gitignore`
- Test: `server/tests/unit/config.test.ts`

**Interfaces:**

- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` with
  `Config { databaseUrl: string; port: number; host: string; allowedHosts: string[];
runnerKey: string; logLevel: string; prPollMs: number; claimWaitMs: number }`.

- [ ] **Step 1: Branch**

```bash
git switch -c feat/slice-1-task-to-pr
```

- [ ] **Step 2: Root files**

`package.json`:

```json
{
  "name": "ai-task-board",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "A board where Claude carries out each task through Spec, Plan, Build and Verify",
  "license": "UNLICENSED",
  "workspaces": ["server"],
  "engines": {
    "node": ">=24.0.0"
  },
  "prettier": "charter/stacks/typescript/prettier",
  "scripts": {
    "test": "./run test",
    "check": "./run check",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "charter": "github:AlexeyVanyukevich/charter#v3.3.0",
    "prettier": "^3.9.6",
    "typescript": "^7.0.2"
  }
}
```

`CLAUDE.md`:

```markdown
# ai-task-board

A board where Claude carries out each task through Spec → Plan → Build → Verify, for one owner
on their own machine.

## The documentation

`docs/architecture.md` is authoritative for what the board does today; Slice 1 creates it. The
decision record is `docs/superpowers/specs/2026-10-10-mvp-design.md` — read it for _why_, never
for what the code does. `docs/backlog.md` lists what is known to be wrong; read it before
planning.

## Conventions

The shared ones come from the `charter` package. `core` loads here, always. Each workspace's
other modules, recorded in `charter.json`, load by path: a rule arrives once a session reads a
file it applies to. Start sessions at the repository root, where one session works on every
workspace.

@node_modules/charter/core/rules.md

`CONTRIBUTING.md` holds this repository's own conventions.
```

`CONTRIBUTING.md`:

```markdown
# Contributing

The conventions this project shares with its siblings come from the `charter` package and are
not restated here. After `npm install`, or the first `./run`, which does it, they are in
`node_modules/charter/`. `charter.json` says which of its modules each workspace takes.
Everything below is this repository's own.

## Layout

`server/`, `runner/` and `web/` are npm workspaces. The server follows the kit's backend
layout; tests sit in each workspace's `tests/{unit,integration}/`, and the browser journeys,
which drive the whole product, at the root in `tests/ui/`.

## The runner's copy of the wire types

`runner/src/contract.ts` repeats the shapes the server's runner and MCP endpoints accept. The
scenario tests in `runner/tests/integration/` run the runner against the real server, and they
are what catches the two drifting apart. Change both in the same commit.

## Commit scopes

`db`, `server`, `mcp`, `runner`, `web`, `ui` for the browser journeys, `deps`. Omit the scope
when the change is repository-wide.

## Before committing

`./run check` — types, formatting, and every workspace's suite. It needs Docker running.
```

`.env.example`:

```
# The compose database. `./run dev` starts it.
DATABASE_URL=postgres://postgres:postgres@localhost:5435/board
# Shared by the server and the runner. `./run` fills it in on the first run.
RUNNER_KEY=
PORT=4100
BOARD_URL=http://127.0.0.1:4100
```

`docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: board
    ports:
      - '127.0.0.1:5435:5432'
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres -d board']
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  db-data:
```

Copy the kit's Prettier ignore file once the kit is installed (Step 5).

- [ ] **Step 3: The `./run` script**

`run` (then `chmod +x run`):

```bash
#!/usr/bin/env bash
#
# One entry point for every way of running this project.
# `./run` with no arguments lists the scenarios.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# This script is what installs dependencies, so it cannot source out of node_modules before the
# kit is there. The test is for the file rather than the directory.
[ -f node_modules/charter/core/lib.sh ] ||
  GITHUB_TOKEN="${GITHUB_TOKEN:-$(gh auth token 2>/dev/null || true)}" npm install
source node_modules/charter/core/lib.sh

load_env_file

DB_HOST_PORT=5435
COMPOSE_DB_URL="postgres://postgres:postgres@localhost:${DB_HOST_PORT}/board"
RUN_STATE=".run"

# ── preflight ────────────────────────────────────────────────────────────────

# The runner key is a secret both processes read from .env. Generated here rather than left
# for the owner to invent, because a blank one stops the server at start with a message about
# a value nobody has been told to choose.
need_local_env() {
  need_env || note "Created .env from .env.example"
  if grep -q '^RUNNER_KEY=$' .env; then
    local key
    key=$(openssl rand -hex 32)
    sed -i.bak "s/^RUNNER_KEY=\$/RUNNER_KEY=${key}/" .env && rm -f .env.bak
    note "Generated RUNNER_KEY in .env"
  fi
  load_env_file
}

start_db() {
  need_docker
  step "Starting PostgreSQL on port ${DB_HOST_PORT}"
  docker compose up -d db </dev/null >/dev/null
  local waited=0
  until docker compose exec -T db pg_isready -U postgres -d board </dev/null >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    [ "$waited" -gt 60 ] && die "PostgreSQL did not become ready within a minute." \
      "Check:  docker compose logs db"
  done
  ok "PostgreSQL ready"
}

run_migrations() {
  step "Applying migrations"
  DATABASE_URL="${DATABASE_URL:-$COMPOSE_DB_URL}" npm run --silent --workspace server migrate
}

# ── scenarios ────────────────────────────────────────────────────────────────

scenario_dev() {
  need_node; need_deps; need_plugins; need_hooks; need_local_env
  start_db
  run_migrations
  export DATABASE_URL="${DATABASE_URL:-$COMPOSE_DB_URL}"
  ok "Server on http://127.0.0.1:${PORT:-4100}"
  note "Ctrl-C stops it"
  npm run --workspace server dev
}

scenario_test() {
  need_node; need_deps; need_plugins; need_hooks; need_docker
  step "Server suite"
  npm run --workspace server test
}

scenario_check() {
  need_node; need_deps; need_plugins; need_hooks
  step "Types"
  ( cd server && npx tsc --noEmit )
  step "Formatting"
  npx prettier --check .
  step "Tests"
  scenario_test
  ok "Everything is clean"
}

scenario_migrate() {
  need_node; need_deps; need_plugins; need_hooks; need_local_env
  start_db
  run_migrations
  ok "Migrations applied"
}

usage() {
  cat <<TEXT
${BOLD}./run <scenario>${OFF}

  ${BOLD}dev${OFF}        PostgreSQL, migrations and the server
  ${BOLD}test${OFF}       every workspace's suite
  ${BOLD}check${OFF}      types, formatting and the suites
  ${BOLD}migrate${OFF}    apply migrations to the local database
TEXT
}

SCENARIO="${1:-}"
[ $# -gt 0 ] && shift || true

case "$SCENARIO" in
  dev)          scenario_dev "$@" ;;
  test)         scenario_test ;;
  check)        scenario_check ;;
  migrate)      scenario_migrate ;;
  ''|-h|--help) usage ;;
  *)            die "Unknown scenario: ${SCENARIO}" "Run ./run with no arguments to see the list." ;;
esac
```

- [ ] **Step 4: The server workspace's files**

`server/package.json`:

```json
{
  "name": "@board/server",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24.0.0"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/src/server.js",
    "dev": "tsx watch src/server.ts",
    "migrate": "tsx src/db/migrate.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@fastify/static": "^10.1.3",
    "@fastify/type-provider-typebox": "^6.1.0",
    "fastify": "^5.10.0",
    "kysely": "^0.29.4",
    "pg": "^8.22.0",
    "typebox": "^1.3.8"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^12.0.4",
    "@types/node": "^26.1.2",
    "@types/pg": "^8.20.0",
    "testcontainers": "^12.0.4",
    "tsx": "^4.23.1",
    "vitest": "^4.1.10"
  }
}
```

`server/tsconfig.json`:

```json
{
  "extends": "charter/stacks/node/tsconfig",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src", "tests", "scripts"]
}
```

`server/vitest.config.ts` (the global setup arrives in Task 2; until then the suite is unit
tests only):

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // One database, truncated between cases.
    fileParallelism: false,
  },
})
```

- [ ] **Step 5: Install, take the kit's ignore files, and record the server's modules**

```bash
npm install
cp node_modules/charter/core/ignore/prettierignore .prettierignore
diff .gitignore node_modules/charter/core/ignore/gitignore
npx --no charter init backend typescript node vitest --workspace server
npx prettier --write package.json server/package.json
```

Prettier lays out a `package.json` the way npm writes it, with every array and object
expanded, which a `json` block in this plan cannot show. Format each `package.json` this way
whenever a later task writes or edits one.

Expected: `npm install` succeeds; `diff` prints nothing (the founding commit copied
`.gitignore` from the kit, and 3.3.0's copy is the same file); `init` writes `charter.json`,
`.claude/settings.json` and `server/.claude/settings.json`, and appends
`.claude/rules/charter/` to `.gitignore`. The `CLAUDE.md` import is already there, so it leaves
that file alone. `ls .claude/rules/charter/server` lists `backend typescript node`, and
`.git/hooks/commit-msg` calls `node_modules/charter/core/hooks/commit-msg`.

- [ ] **Step 6: Write the failing test**

`server/tests/unit/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

const BASE = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5435/board',
  RUNNER_KEY: 'k'.repeat(32),
}

describe('loadConfig', () => {
  it('fills the defaults', () => {
    expect(loadConfig(BASE)).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      port: 4100,
      host: '127.0.0.1',
      allowedHosts: ['localhost', '127.0.0.1'],
      runnerKey: BASE.RUNNER_KEY,
      logLevel: 'info',
      prPollMs: 180_000,
      claimWaitMs: 30_000,
    })
  })

  it('reads a comma-separated host list, trimmed and lower-cased', () => {
    const config = loadConfig({ ...BASE, ALLOWED_HOSTS: ' localhost, Board.Local ' })
    expect(config.allowedHosts).toEqual(['localhost', 'board.local'])
  })

  it.each([
    ['no database', { ...BASE, DATABASE_URL: '' }, /DATABASE_URL is required/],
    ['no runner key', { ...BASE, RUNNER_KEY: '' }, /RUNNER_KEY is required/],
    ['a short runner key', { ...BASE, RUNNER_KEY: 'short' }, /RUNNER_KEY must be/],
    ['a port that is not a number', { ...BASE, PORT: 'abc' }, /PORT must be/],
    ['a port of zero', { ...BASE, PORT: '0' }, /PORT must be/],
    ['an empty host list', { ...BASE, ALLOWED_HOSTS: ' , ' }, /ALLOWED_HOSTS/],
  ])('refuses %s', (_name, env, message) => {
    expect(() => loadConfig(env)).toThrow(message)
  })
})
```

- [ ] **Step 7: Run it to see it fail**

Run: `npm run --workspace server test -- tests/unit/config.test.ts`
Expected: FAIL — `Cannot find module '../../src/config.js'`.

- [ ] **Step 8: Implement**

`server/src/config.ts`:

```ts
export interface Config {
  databaseUrl: string
  port: number
  /** Always loopback: the board has no sign-in, so it must not be reachable from a network. */
  host: string
  /** Host names a request may be addressed to. Anything else is a DNS-rebinding attempt. */
  allowedHosts: string[]
  /** Shared with the runner; authenticates claim and heartbeat. */
  runnerKey: string
  logLevel: string
  prPollMs: number
  /** How long a claim waits for work before answering empty. */
  claimWaitMs: number
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`Invalid configuration: ${key} is required`)
  }
  return value
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid configuration: ${key} must be a positive integer, got "${raw}"`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const runnerKey = required(env, 'RUNNER_KEY')
  if (runnerKey.length < 32) {
    throw new Error('Invalid configuration: RUNNER_KEY must be at least 32 characters')
  }

  const allowedHosts = (env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '')
  if (allowedHosts.length === 0) {
    throw new Error('Invalid configuration: ALLOWED_HOSTS names no host')
  }

  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    port: positiveInt(env, 'PORT', 4100),
    host: '127.0.0.1',
    allowedHosts,
    runnerKey,
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    prPollMs: positiveInt(env, 'PR_POLL_MS', 180_000),
    claimWaitMs: positiveInt(env, 'CLAIM_WAIT_MS', 30_000),
  }
}
```

- [ ] **Step 9: Run it to see it pass, then check everything**

Run: `npm run --workspace server test -- tests/unit/config.test.ts`
Expected: PASS, 8 tests.

Run: `./run check`
Expected: ends `✓ Everything is clean`.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json CLAUDE.md CONTRIBUTING.md .env.example .prettierignore \
  .gitignore docker-compose.yml run charter.json .claude/settings.json server
git commit -m "build: lay out the repository on the kit with the server's configuration"
```

---

### Task 2: The database

**Files:**

- Create: `server/src/shared/vocabulary.ts`, `server/src/db/client.ts`, `server/src/db/schema.ts`, `server/src/db/migrate.ts`,
  `server/src/db/migrations/index.ts`, `server/src/db/migrations/001_initial.ts`
- Create: `server/tests/integration/global-setup.ts`, `server/tests/integration/helpers.ts`
- Modify: `server/vitest.config.ts`
- Test: `server/tests/integration/migrations.test.ts`

**Interfaces:**

- Produces: `createDb(url: string): Kysely<Database>`; `runMigrations(db): Promise<void>`;
  the `Database` interface below; test helpers `getTestDb()`, `resetDb()`, `closeTestDb()`.
- Produces the state and kind vocabularies every later task uses:
  `TASK_STATES`, `RUN_STATUSES`, `PHASE_NAMES`, `EVENT_TYPES`, `ARTIFACT_KINDS`, their union
  types and `SpecCriterion`, exported from `server/src/shared/vocabulary.ts`.

- [ ] **Step 1: The schema types**

`server/src/shared/vocabulary.ts` — the state and kind lists, outside `db/` so the pure cores
can import them:

```ts
export const TASK_STATES = [
  'backlog',
  'spec_draft',
  'spec_review',
  'ready',
  'running',
  'needs_approval',
  'review',
  'done',
  'blocked',
  'failed',
] as const
export type TaskState = (typeof TASK_STATES)[number]

/** Slice 1's run statuses. Slice 2 adds `paused` and `blocked` with its own migration. */
export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const PHASE_NAMES = ['spec', 'plan', 'build', 'verify'] as const
export type PhaseName = (typeof PHASE_NAMES)[number]

export const EVENT_TYPES = [
  'phase_start',
  'phase_end',
  'message',
  'tool_call',
  'subagent_start',
  'subagent_stop',
  'approval_requested',
  'approval_answered',
  'checkpoint',
  'error',
  'run_end',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const ARTIFACT_KINDS = ['plan', 'verify_report', 'pr'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/** One acceptance criterion as the spec parser reads it and approval freezes it. */
export interface SpecCriterion {
  id: string
  requirements: string[]
  text: string
}
```

`server/src/db/schema.ts`:

```ts
import type { ColumnType, Generated, JSONColumnType } from 'kysely'
import type {
  ArtifactKind,
  EventType,
  PhaseName,
  RunStatus,
  SpecCriterion,
  TaskState,
} from '../shared/vocabulary.js'

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>
/** `numeric` comes back from pg as a string; it is parsed where it is read. */
type Numeric = ColumnType<string, number | string, number | string>

export interface ProjectsTable {
  id: Generated<string>
  key: string
  name: string
  repo_path: string
  github_repo: string
  base_branch: string
  test_command: string
  next_task_number: Generated<number>
  created_at: Generated<Date>
}

export interface TasksTable {
  id: Generated<string>
  project_id: string
  number: number
  title: string
  description_md: Generated<string>
  state: TaskState
  position: number
  budget_usd: ColumnType<string | null, number | null | undefined, number | null>
  created_at: Generated<Date>
  updated_at: Timestamp
}

export interface SpecsTable {
  id: Generated<string>
  task_id: string
  version: number
  body_md: string
  criteria: JSONColumnType<SpecCriterion[] | null, string | null, string | null>
  status: 'draft' | 'approved' | 'superseded'
  approved_at: NullableTimestamp
  created_at: Generated<Date>
}

export interface RunsTable {
  id: Generated<string>
  task_id: string
  kind: 'spec' | 'delivery'
  spec_version: number
  status: RunStatus
  current_phase: PhaseName | null
  branch: string | null
  worktree_path: string | null
  pr_number: number | null
  pr_url: string | null
  fix_loops: Generated<number>
  failure_reason: string | null
  runner_id: string | null
  cancel_requested: Generated<boolean>
  created_at: Generated<Date>
  started_at: NullableTimestamp
  ended_at: NullableTimestamp
  last_heartbeat_at: NullableTimestamp
}

export interface RunTokensTable {
  id: Generated<string>
  run_id: string
  token_hash: string
  expires_at: Timestamp
  created_at: Generated<Date>
}

export interface PhasesTable {
  /** Generated by the runner, so a replayed `phase_start` is recognised. */
  id: string
  run_id: string
  name: PhaseName
  attempt: number
  agent: string
  model: string
  status: 'running' | 'succeeded' | 'failed'
  session_id: string | null
  summary_md: string | null
  /** Claude Code's own cost per model for this phase: `{ "<model>": <usd> }`. */
  reported_cost: JSONColumnType<Record<string, number> | null, string | null, string | null>
  started_at: Timestamp
  ended_at: NullableTimestamp
}

export interface EventsTable {
  /** Generated by the runner or the hook: a replay of the same event is a no-op. */
  id: string
  run_id: string
  phase_id: string | null
  ts: Timestamp
  type: EventType
  agent: string | null
  model: string | null
  tool: string | null
  target: string | null
  status: string | null
  duration_ms: number | null
  input: number
  output: number
  cache_read: number
  cache_write: number
  payload: JSONColumnType<Record<string, unknown>, string, string>
  received_at: Generated<Date>
}

export interface ApprovalRequestsTable {
  id: Generated<string>
  run_id: string
  phase_id: string | null
  kind: string
  question: string
  options: JSONColumnType<unknown[], string, string>
  recommendation: string | null
  context_md: string | null
  status: 'open' | 'answered' | 'expired'
  answer: ColumnType<unknown, string | null, string | null>
  checkpoint: ColumnType<unknown, string | null, string | null>
  created_at: Generated<Date>
  answered_at: NullableTimestamp
}

export interface ArtifactsTable {
  id: Generated<string>
  run_id: string
  phase_id: string | null
  kind: ArtifactKind
  body_md: string
  uri: string | null
  data: ColumnType<unknown, string | null, string | null>
  created_at: Generated<Date>
}

export interface PricesTable {
  model: string
  effective_from: ColumnType<Date, string, string>
  input: Numeric
  output: Numeric
  cache_read: Numeric
  cache_write: Numeric
}

export interface Database {
  projects: ProjectsTable
  tasks: TasksTable
  specs: SpecsTable
  runs: RunsTable
  run_tokens: RunTokensTable
  phases: PhasesTable
  events: EventsTable
  approval_requests: ApprovalRequestsTable
  artifacts: ArtifactsTable
  prices: PricesTable
}
```

- [ ] **Step 2: Client and migrator**

`server/src/db/client.ts`:

```ts
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.js'

// int8 arrives as a string to avoid losing precision; every count here fits a JS number, and
// a string count is a bug waiting to be concatenated.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value))

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  })
}
```

`server/src/db/migrate.ts`:

```ts
import { fileURLToPath } from 'node:url'
import type { Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import { createDb } from './client.js'
import { migrations } from './migrations/index.js'
import type { Database } from './schema.js'

export async function runMigrations(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } })
  const { error, results } = await migrator.migrateToLatest()
  for (const result of results ?? []) {
    if (result.status === 'Error') throw new Error(`Migration "${result.migrationName}" failed`)
  }
  if (error) throw error
}

// `npm run migrate`. DATABASE_URL alone: creating tables needs no runner key.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required to run migrations')
  }
  const db = createDb(databaseUrl)
  try {
    await runMigrations(db)
    console.log('migrations applied')
  } finally {
    await db.destroy()
  }
}
```

`server/src/db/migrations/index.ts`:

```ts
import type { Migration } from 'kysely/migration'
import * as initial from './001_initial.js'

/**
 * Listed rather than discovered from disk: a file provider imports at runtime, which fails
 * wherever TypeScript cannot be loaded directly, such as Vitest's global setup. Keys are the
 * names Kysely records; they apply in lexicographic order, so keep the numeric prefix.
 */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
}
```

- [ ] **Step 3: The migration**

`server/src/db/migrations/001_initial.ts`:

```ts
import { Kysely, sql } from 'kysely'

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

const TASK_STATES = [
  'backlog',
  'spec_draft',
  'spec_review',
  'ready',
  'running',
  'needs_approval',
  'review',
  'done',
  'blocked',
  'failed',
]
const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
const PHASE_NAMES = ['spec', 'plan', 'build', 'verify']
const EVENT_TYPES = [
  'phase_start',
  'phase_end',
  'message',
  'tool_call',
  'subagent_start',
  'subagent_stop',
  'approval_requested',
  'approval_answered',
  'checkpoint',
  'error',
  'run_end',
]

// The vocabularies are repeated here rather than imported from schema.ts: a migration is a
// record of what was applied, and must not change when the code's lists grow later.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('projects')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('key', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('repo_path', 'text', (col) => col.notNull().unique())
    .addColumn('github_repo', 'text', (col) => col.notNull())
    .addColumn('base_branch', 'text', (col) => col.notNull())
    .addColumn('test_command', 'text', (col) => col.notNull())
    .addColumn('next_task_number', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('projects_key_shape', sql`key ~ '^[A-Z][A-Z0-9]{1,9}$'`)
    .addCheckConstraint('projects_repo_shape', sql`github_repo ~ '^[^/\\s]+/[^/\\s]+$'`)
    .execute()

  await db.schema
    .createTable('tasks')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('project_id', 'uuid', (col) => col.notNull().references('projects.id'))
    .addColumn('number', 'integer', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('description_md', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('state', 'text', (col) => col.notNull())
    .addColumn('position', 'double precision', (col) => col.notNull())
    .addColumn('budget_usd', 'numeric(10, 2)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('tasks_number_unique', ['project_id', 'number'])
    .addCheckConstraint('tasks_state_known', sql`state in (${list(TASK_STATES)})`)
    .addCheckConstraint('tasks_title_not_blank', sql`length(btrim(title)) > 0`)
    .addCheckConstraint('tasks_budget_positive', sql`budget_usd is null or budget_usd > 0`)
    .execute()

  await db.schema
    .createTable('specs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('task_id', 'uuid', (col) => col.notNull().references('tasks.id').onDelete('cascade'))
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('body_md', 'text', (col) => col.notNull())
    .addColumn('criteria', 'jsonb')
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('approved_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('specs_version_unique', ['task_id', 'version'])
    .addCheckConstraint('specs_status_known', sql`status in ('draft', 'approved', 'superseded')`)
    .execute()

  await db.schema
    .createTable('runs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('task_id', 'uuid', (col) => col.notNull().references('tasks.id').onDelete('cascade'))
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('spec_version', 'integer', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('current_phase', 'text')
    .addColumn('branch', 'text')
    .addColumn('worktree_path', 'text')
    .addColumn('pr_number', 'integer')
    .addColumn('pr_url', 'text')
    .addColumn('fix_loops', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('failure_reason', 'text')
    .addColumn('runner_id', 'text')
    .addColumn('cancel_requested', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('started_at', 'timestamptz')
    .addColumn('ended_at', 'timestamptz')
    .addColumn('last_heartbeat_at', 'timestamptz')
    .addCheckConstraint('runs_kind_known', sql`kind in ('spec', 'delivery')`)
    .addCheckConstraint('runs_status_known', sql`status in (${list(RUN_STATUSES)})`)
    .addCheckConstraint(
      'runs_phase_known',
      sql`current_phase is null or current_phase in (${list(PHASE_NAMES)})`,
    )
    .execute()
  await db.schema.createIndex('runs_queued').on('runs').columns(['status', 'created_at']).execute()

  await db.schema
    .createTable('run_tokens')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('run_id', 'uuid', (col) => col.notNull().references('runs.id').onDelete('cascade'))
    .addColumn('token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createTable('phases')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('run_id', 'uuid', (col) => col.notNull().references('runs.id').onDelete('cascade'))
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('attempt', 'integer', (col) => col.notNull())
    .addColumn('agent', 'text', (col) => col.notNull())
    .addColumn('model', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('session_id', 'uuid')
    .addColumn('summary_md', 'text')
    .addColumn('reported_cost', 'jsonb')
    .addColumn('started_at', 'timestamptz', (col) => col.notNull())
    .addColumn('ended_at', 'timestamptz')
    .addCheckConstraint('phases_name_known', sql`name in (${list(PHASE_NAMES)})`)
    .addCheckConstraint('phases_status_known', sql`status in ('running', 'succeeded', 'failed')`)
    .execute()

  await db.schema
    .createTable('events')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('run_id', 'uuid', (col) => col.notNull().references('runs.id').onDelete('cascade'))
    .addColumn('phase_id', 'uuid')
    .addColumn('ts', 'timestamptz', (col) => col.notNull())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('agent', 'text')
    .addColumn('model', 'text')
    .addColumn('tool', 'text')
    .addColumn('target', 'text')
    .addColumn('status', 'text')
    .addColumn('duration_ms', 'integer')
    .addColumn('input', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('output', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('cache_read', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('cache_write', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('received_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('events_type_known', sql`type in (${list(EVENT_TYPES)})`)
    .addCheckConstraint(
      'events_usage_not_negative',
      sql`input >= 0 and output >= 0 and cache_read >= 0 and cache_write >= 0`,
    )
    .execute()
  await db.schema
    .createIndex('events_by_run')
    .on('events')
    .columns(['run_id', 'ts', 'id'])
    .execute()
  await db.schema.createIndex('events_by_phase').on('events').column('phase_id').execute()

  await db.schema
    .createTable('approval_requests')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('run_id', 'uuid', (col) => col.notNull().references('runs.id').onDelete('cascade'))
    .addColumn('phase_id', 'uuid')
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('question', 'text', (col) => col.notNull())
    .addColumn('options', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('recommendation', 'text')
    .addColumn('context_md', 'text')
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('answer', 'jsonb')
    .addColumn('checkpoint', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('answered_at', 'timestamptz')
    .addCheckConstraint('approvals_status_known', sql`status in ('open', 'answered', 'expired')`)
    .execute()

  await db.schema
    .createTable('artifacts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('run_id', 'uuid', (col) => col.notNull().references('runs.id').onDelete('cascade'))
    .addColumn('phase_id', 'uuid')
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('body_md', 'text', (col) => col.notNull())
    .addColumn('uri', 'text')
    .addColumn('data', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('artifacts_kind_known', sql`kind in ('plan', 'verify_report', 'pr')`)
    .execute()

  await db.schema
    .createTable('prices')
    .addColumn('model', 'text', (col) => col.notNull())
    .addColumn('effective_from', 'date', (col) => col.notNull())
    .addColumn('input', 'numeric(12, 6)', (col) => col.notNull())
    .addColumn('output', 'numeric(12, 6)', (col) => col.notNull())
    .addColumn('cache_read', 'numeric(12, 6)', (col) => col.notNull())
    .addColumn('cache_write', 'numeric(12, 6)', (col) => col.notNull())
    .addPrimaryKeyConstraint('prices_pk', ['model', 'effective_from'])
    .addCheckConstraint(
      'prices_not_negative',
      sql`input >= 0 and output >= 0 and cache_read >= 0 and cache_write >= 0`,
    )
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of [
    'prices',
    'artifacts',
    'approval_requests',
    'events',
    'phases',
    'run_tokens',
    'runs',
    'specs',
    'tasks',
    'projects',
  ]) {
    await db.schema.dropTable(table).execute()
  }
}
```

- [ ] **Step 4: Test harness**

`server/tests/integration/global-setup.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { createDb } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'

let container: StartedPostgreSqlContainer

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
  }
}

interface GlobalSetupContext {
  provide: <K extends keyof import('vitest').ProvidedContext>(key: K, value: string) => void
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const databaseUrl = container.getConnectionUri()
  const db = createDb(databaseUrl)
  try {
    await runMigrations(db)
  } finally {
    await db.destroy()
  }
  provide('databaseUrl', databaseUrl)
}

export async function teardown(): Promise<void> {
  await container?.stop()
}
```

`server/tests/integration/helpers.ts`:

```ts
import { inject } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { createDb } from '../../src/db/client.js'
import type { Database } from '../../src/db/schema.js'

let cached: Kysely<Database> | undefined

export function getTestDb(): Kysely<Database> {
  cached ??= createDb(inject('databaseUrl'))
  return cached
}

export async function closeTestDb(): Promise<void> {
  await cached?.destroy()
  cached = undefined
}

export async function resetDb(): Promise<void> {
  await sql`truncate table events, phases, artifacts, approval_requests, run_tokens, runs,
    specs, tasks, projects, prices restart identity cascade`.execute(getTestDb())
}
```

`server/vitest.config.ts` — add the global setup:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./tests/integration/global-setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // One database, truncated between cases.
    fileParallelism: false,
  },
})
```

- [ ] **Step 5: Write the failing test**

`server/tests/integration/migrations.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { EVENT_TYPES, TASK_STATES } from '../../src/shared/vocabulary.js'

beforeEach(resetDb)
afterAll(closeTestDb)

async function project() {
  return getTestDb()
    .insertInto('projects')
    .values({
      key: 'PAY',
      name: 'Payments',
      repo_path: '/tmp/pay',
      github_repo: 'owner/pay',
      base_branch: 'main',
      test_command: 'npm test',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}

describe('the initial migration', () => {
  it('creates every table in the spec', async () => {
    const { rows } = await sql<{ table_name: string }>`
      select table_name from information_schema.tables where table_schema = 'public'
    `.execute(getTestDb())
    expect(rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'projects',
        'tasks',
        'specs',
        'runs',
        'run_tokens',
        'phases',
        'events',
        'approval_requests',
        'artifacts',
        'prices',
      ]),
    )
  })

  // Derived from the code's own list, so the constraint and the type cannot drift apart
  // without this failing.
  it.each(TASK_STATES)('accepts the task state %s', async (state) => {
    const { id } = await project()
    await expect(
      getTestDb()
        .insertInto('tasks')
        .values({
          project_id: id,
          number: 1,
          title: 'T',
          state,
          position: 1,
          updated_at: new Date(),
        })
        .execute(),
    ).resolves.toBeDefined()
  })

  it.each(EVENT_TYPES)('accepts the event type %s', async (type) => {
    const { id } = await project()
    const task = await getTestDb()
      .insertInto('tasks')
      .values({
        project_id: id,
        number: 1,
        title: 'T',
        state: 'running',
        position: 1,
        updated_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const run = await getTestDb()
      .insertInto('runs')
      .values({
        task_id: task.id,
        kind: 'delivery',
        spec_version: 1,
        status: 'running',
        current_phase: null,
        branch: null,
        worktree_path: null,
        pr_number: null,
        pr_url: null,
        failure_reason: null,
        runner_id: null,
        started_at: null,
        ended_at: null,
        last_heartbeat_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await expect(
      getTestDb()
        .insertInto('events')
        .values({
          id: crypto.randomUUID(),
          run_id: run.id,
          phase_id: null,
          ts: new Date(),
          type,
          agent: null,
          model: null,
          tool: null,
          target: null,
          status: null,
          duration_ms: null,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          payload: '{}',
        })
        .execute(),
    ).resolves.toBeDefined()
  })

  it.each([
    ['a lower-case key', { key: 'pay' }],
    ['a one-letter key', { key: 'P' }],
    ['a repository without an owner', { github_repo: 'pay' }],
  ])('refuses a project with %s', async (_name, change) => {
    await expect(
      getTestDb()
        .insertInto('projects')
        .values({
          key: 'PAY',
          name: 'P',
          repo_path: '/tmp/p',
          github_repo: 'o/p',
          base_branch: 'main',
          test_command: 'npm test',
          ...change,
        })
        .execute(),
    ).rejects.toThrow(/violates check constraint/)
  })

  it('refuses a task state it does not know', async () => {
    const { id } = await project()
    await expect(
      sql`insert into tasks (project_id, number, title, state, position)
          values (${id}, 1, 'T', 'archived', 1)`.execute(getTestDb()),
    ).rejects.toThrow(/tasks_state_known/)
  })
})
```

- [ ] **Step 6: Run it to see it fail**

Run: `npm run --workspace server test -- tests/integration/migrations.test.ts`
Expected: FAIL — the global setup cannot import `001_initial.js` until Step 3's file exists; if
the files are already written, fix whichever assertion fails before moving on.

- [ ] **Step 7: Run it to see it pass**

Run: `npm run --workspace server test`
Expected: PASS — config and migration suites.

- [ ] **Step 8: Commit**

```bash
git add server
git commit -m "feat(db): create every table the spec names"
```

---

### Task 3: The application shell — errors, host and origin checks, health

**Files:**

- Create: `server/src/shared/errors.ts`, `server/src/shared/hosts.ts`, `server/src/shared/schemas.ts`,
  `server/src/app.ts`, `server/src/server.ts`
- Modify: `server/tests/integration/helpers.ts` (add `buildTestApp`)
- Test: `server/tests/unit/hosts.test.ts`, `server/tests/integration/shell.test.ts`

**Interfaces:**

- Consumes: `Config`, `createDb`, `Database`.
- Produces: `AppError` and its subclasses `ValidationError` (400 `validation_error`),
  `UnauthorizedError` (401 `unauthorized`), `ForbiddenOriginError` (403 `forbidden_origin`),
  `NotFoundError` (404 `not_found`), `ConflictError` (409 `conflict`);
  `registerErrorHandler(app)`; `isAllowedHost(hostHeader: string | undefined, allowed: string[]): boolean`;
  `isSameOrigin(origin: string | undefined, hostHeader: string | undefined): boolean`;
  `NonBlankString({ maxLength })`; `buildApp(deps: AppDeps): Promise<FastifyInstance>` with
  `AppDeps { config: Config; db: Kysely<Database>; clock?: () => Date }` and Fastify decorations
  `app.db`, `app.config`, `app.clock`; `buildTestApp(overrides?): Promise<FastifyInstance>`.

- [ ] **Step 1: Write the failing unit test**

`server/tests/unit/hosts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isAllowedHost, isSameOrigin } from '../../src/shared/hosts.js'

const ALLOWED = ['localhost', '127.0.0.1']

describe('isAllowedHost', () => {
  it.each([
    ['localhost:4100', true],
    ['127.0.0.1:4100', true],
    ['LOCALHOST:4100', true],
    ['localhost', true],
    // DNS rebinding: an attacker's name resolving to 127.0.0.1 arrives with its own Host.
    ['evil.example:4100', false],
    ['localhost.evil.example', false],
    ['[::1]:4100', false],
    [undefined, false],
    ['', false],
  ])('%s → %s', (host, expected) => {
    expect(isAllowedHost(host, ALLOWED)).toBe(expected)
  })
})

describe('isSameOrigin', () => {
  it.each([
    ['no Origin header (curl, the runner)', undefined, 'localhost:4100', true],
    ['the app itself', 'http://localhost:4100', 'localhost:4100', true],
    ['the default port spelled out in Host', 'http://localhost', 'localhost:80', true],
    ['the default port spelled out in Origin', 'http://localhost:80', 'localhost', true],
    ['a Host in another case', 'http://localhost:4100', 'LocalHost:4100', true],
    ['another site', 'https://evil.example', 'localhost:4100', false],
    ['the same host on another port', 'http://localhost:5174', 'localhost:4100', false],
    ['an Origin that is not a URL', 'null', 'localhost:4100', false],
  ])('%s', (_name, origin, host, expected) => {
    expect(isSameOrigin(origin, host)).toBe(expected)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run --workspace server test -- tests/unit/hosts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the checks and the errors**

`server/src/shared/hosts.ts`:

```ts
/** The host name of a `Host` header, without its port, lower-cased. IPv6 literals are refused. */
function hostName(hostHeader: string): string | undefined {
  if (hostHeader.startsWith('[')) return undefined
  const name = hostHeader.split(':')[0]?.trim().toLowerCase()
  return name === '' ? undefined : name
}

export function isAllowedHost(hostHeader: string | undefined, allowed: string[]): boolean {
  if (hostHeader === undefined) return false
  const name = hostName(hostHeader)
  return name !== undefined && allowed.includes(name)
}

/**
 * A write from a browser carries `Origin`; one from the runner or curl does not, and those are
 * not what this check is for. An Origin that is present must name the host the request was
 * addressed to, port included. The Host is read as a URL under the Origin's scheme, so a
 * default port spelled out on one side (`localhost:80`) still matches its absence on the other.
 */
export function isSameOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (origin === undefined) return true
  if (hostHeader === undefined) return false
  try {
    const from = new URL(origin)
    return from.host === new URL(`${from.protocol}//${hostHeader}`).host
  } catch {
    return false
  }
}
```

`server/src/shared/errors.ts`:

```ts
import type { FastifyError, FastifyInstance } from 'fastify'

export abstract class AppError extends Error {
  abstract readonly statusCode: number
  abstract readonly code: string
  readonly details?: Record<string, unknown>

  constructor(message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = new.target.name
    if (details !== undefined) this.details = details
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400
  readonly code = 'validation_error'
}

/** Every authentication failure is this one, with the same message, whatever went wrong. */
export class UnauthorizedError extends AppError {
  readonly statusCode = 401
  readonly code = 'unauthorized'
  constructor() {
    super('Missing or invalid credential')
  }
}

export class ForbiddenOriginError extends AppError {
  readonly statusCode = 403
  readonly code = 'forbidden_origin'
}

export class NotFoundError extends AppError {
  readonly statusCode = 404
  readonly code = 'not_found'
}

/** The client's view was stale: re-read and retry. */
export class ConflictError extends AppError {
  readonly statusCode = 409
  readonly code = 'conflict'
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      })
      return
    }
    if (error.validation) {
      void reply.status(400).send({
        error: 'validation_error',
        message: error.message,
        details: { issues: error.validation },
      })
      return
    }
    if (error.statusCode === 413) {
      void reply.status(413).send({ error: 'payload_too_large', message: error.message })
      return
    }
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      void reply.status(error.statusCode).send({ error: 'bad_request', message: error.message })
      return
    }
    request.log.error({ err: error }, 'unhandled error')
    void reply.status(500).send({ error: 'internal_error', message: 'Internal server error' })
  })
}
```

`server/src/shared/schemas.ts`:

```ts
import { Type } from 'typebox'

/**
 * `minLength: 1` accepts `"   "`, which then reaches a check constraint as a 500. One non-space
 * character keeps the refusal at the boundary, where it can name the field.
 */
export function NonBlankString(options: { maxLength: number }) {
  return Type.String({ minLength: 1, pattern: '\\S', maxLength: options.maxLength })
}

export const Uuid = Type.String({ format: 'uuid' })
```

- [ ] **Step 4: Run the unit test to see it pass**

Run: `npm run --workspace server test -- tests/unit/hosts.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing integration test**

Add to `server/tests/integration/helpers.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { buildApp, type AppDeps } from '../../src/app.js'
import type { Config } from '../../src/config.js'

export const TEST_RUNNER_KEY = 'r'.repeat(40)

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: inject('databaseUrl'),
    port: 0,
    host: '127.0.0.1',
    allowedHosts: ['localhost', '127.0.0.1'],
    runnerKey: TEST_RUNNER_KEY,
    logLevel: 'silent',
    prPollMs: 180_000,
    claimWaitMs: 0,
    ...overrides,
  }
}

/**
 * Built and made ready, so the bus is listening before a test waits on it. `extend` adds routes
 * a test needs before the app is sealed. `app.inject` sends `Host: localhost:80`, which the
 * host check allows.
 */
export async function buildTestApp(
  overrides: Partial<Omit<AppDeps, 'config' | 'db'>> & { config?: Partial<Config> } = {},
  extend?: (app: FastifyInstance) => void,
): Promise<FastifyInstance> {
  const { config, ...rest } = overrides
  const app = await buildApp({ config: testConfig(config), db: getTestDb(), ...rest })
  extend?.(app)
  await app.ready()
  return app
}
```

`server/tests/integration/shell.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp({}, (instance) => {
    // A route that writes, to exercise the origin check without a feature.
    instance.post('/api/echo', async (request) => request.body)
    instance.get('/api/boom', async () => {
      throw new Error('table "secret_structure" does not exist')
    })
  })
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('the shell', () => {
  it('answers health', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('answers an unknown API path in the shared shape', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('not_found')
  })

  it('never leaks an unexpected error', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/boom' })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: 'internal_error', message: 'Internal server error' })
  })

  it('translates a malformed JSON body into bad_request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"oops',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('bad_request')
  })

  it.each([
    ['a foreign Host', { host: 'evil.example' }, 'GET', 403],
    ['a write from another site', { origin: 'https://evil.example' }, 'POST', 403],
    ['a write from the app itself', { origin: 'http://localhost:80' }, 'POST', 200],
    ['a write with no Origin', {}, 'POST', 200],
  ] as const)('%s', async (_name, headers, method, status) => {
    const response = await app.inject({
      method,
      url: method === 'GET' ? '/api/health' : '/api/echo',
      headers: { ...headers },
      ...(method === 'POST' ? { payload: { a: 1 } } : {}),
    })
    expect(response.statusCode).toBe(status)
    if (status === 403) expect(response.json().error).toBe('forbidden_origin')
  })
})
```

- [ ] **Step 6: Run it to see it fail**

Run: `npm run --workspace server test -- tests/integration/shell.test.ts`
Expected: FAIL — `Cannot find module '../../src/app.js'`.

- [ ] **Step 7: Implement the app and the entry point**

`server/src/app.ts`:

```ts
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { Kysely } from 'kysely'
import type { Config } from './config.js'
import type { Database } from './db/schema.js'
import { ForbiddenOriginError, registerErrorHandler } from './shared/errors.js'
import { isAllowedHost, isSameOrigin } from './shared/hosts.js'

export interface AppDeps {
  config: Config
  db: Kysely<Database>
  /** Injected so sweepers and expiries are testable without waiting. */
  clock?: () => Date
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<Database>
    config: Config
    clock: () => Date
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      redact: ['req.headers.authorization'],
    },
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: 5 * 1024 * 1024,
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.decorate('db', deps.db)
  app.decorate('config', deps.config)
  app.decorate('clock', deps.clock ?? (() => new Date()))
  registerErrorHandler(app)

  // No sign-in is not no protection: any page open in the owner's browser can reach 127.0.0.1.
  app.addHook('onRequest', async (request) => {
    if (!isAllowedHost(request.headers.host, deps.config.allowedHosts)) {
      throw new ForbiddenOriginError('This host is not one the board answers to')
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (!isSameOrigin(request.headers.origin, request.headers.host)) {
        throw new ForbiddenOriginError('This request did not come from the board')
      }
    }
  })

  app.get('/api/health', async () => ({ status: 'ok' }))

  await registerSpa(app)
  return app
}

/**
 * The single-page app is served from the same origin as the API. Unknown non-API paths fall
 * through to index.html so a client-side route survives a reload.
 */
async function registerSpa(app: FastifyInstance): Promise<void> {
  const root = [
    resolve(import.meta.dirname, '../public'),
    resolve(import.meta.dirname, '../../public'),
  ].find((candidate) => existsSync(join(candidate, 'index.html')))

  if (root !== undefined) {
    await app.register(fastifyStatic, { root, index: ['index.html'] })
  } else {
    app.log.warn('no web build to serve; run npm run --workspace web build')
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/mcp') || root === undefined) {
      return reply.status(404).send({ error: 'not_found', message: 'Route not found' })
    }
    return reply.sendFile('index.html')
  })
}
```

`server/src/server.ts`:

```ts
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'

const config = loadConfig(process.env)
const db = createDb(config.databaseUrl)
const app = await buildApp({ config, db })

app.addHook('onClose', async () => {
  await db.destroy()
})

try {
  await app.listen({ port: config.port, host: config.host })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
```

- [ ] **Step 8: Run it to see it pass**

Run: `npm run --workspace server test`
Expected: PASS — every suite so far.

- [ ] **Step 9: Commit**

```bash
git add server
git commit -m "feat(server): answer only to the board's own host and origin"
```

---

## Phase B — the pure cores

Three tasks with no database and no network. Each ends with `grep -l "db/" <file>` printing
nothing.

### Task 4: The transition table

**Files:**

- Create: `server/src/modules/tasks/transitions.ts`
- Test: `server/tests/unit/transitions.test.ts`

**Interfaces:**

- Consumes: `TaskState`, `TASK_STATES` from `shared/vocabulary.ts`.
- Produces: `MOVES`, `type Move`, `nextState(from: TaskState, move: Move): TaskState | undefined`.

Slice 1's moves only. Slice 2 adds the approval and Blocked moves, Slice 3 the spec-run ones,
each by adding rows here.

| Move            | From                 | To          | Actor                                   |
| --------------- | -------------------- | ----------- | --------------------------------------- |
| `save_spec`     | backlog, spec_review | spec_review | owner saves a spec by hand              |
| `approve`       | spec_review          | ready       | owner                                   |
| `claim`         | ready                | running     | runner                                  |
| `finish_review` | running              | review      | runner: every criterion passed, PR open |
| `fail`          | running              | failed      | runner                                  |
| `cancel`        | ready, running       | failed      | owner                                   |
| `rerun`         | failed               | ready       | owner                                   |
| `merge`         | review               | done        | PR poller                               |
| `drag_done`     | review               | done        | owner drags                             |
| `close_pr`      | review               | failed      | PR poller                               |

- [ ] **Step 1: Write the failing test**

`server/tests/unit/transitions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MOVES, nextState, type Move } from '../../src/modules/tasks/transitions.js'
import { TASK_STATES, type TaskState } from '../../src/shared/vocabulary.js'

/** Slice 1's rows of the spec's §5 table, written out independently of the implementation. */
const ALLOWED: [TaskState, Move, TaskState][] = [
  ['backlog', 'save_spec', 'spec_review'],
  ['spec_review', 'save_spec', 'spec_review'],
  ['spec_review', 'approve', 'ready'],
  ['ready', 'claim', 'running'],
  ['running', 'finish_review', 'review'],
  ['running', 'fail', 'failed'],
  ['ready', 'cancel', 'failed'],
  ['running', 'cancel', 'failed'],
  ['failed', 'rerun', 'ready'],
  ['review', 'merge', 'done'],
  ['review', 'drag_done', 'done'],
  ['review', 'close_pr', 'failed'],
]

describe('nextState', () => {
  it.each(ALLOWED)('%s --%s--> %s', (from, move, to) => {
    expect(nextState(from, move)).toBe(to)
  })

  const allowedKeys = new Set(ALLOWED.map(([from, move]) => `${from}/${move}`))
  const refused = TASK_STATES.flatMap((from) =>
    MOVES.filter((move) => !allowedKeys.has(`${from}/${move}`)).map(
      (move) => [from, move] as const,
    ),
  )

  it.each(refused)('refuses %s --%s-->', (from, move) => {
    expect(nextState(from, move)).toBeUndefined()
  })

  it('has no move the table above does not mention', () => {
    expect(new Set(MOVES)).toEqual(new Set(ALLOWED.map(([, move]) => move)))
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run --workspace server test -- tests/unit/transitions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/modules/tasks/transitions.ts`:

```ts
import type { TaskState } from '../../shared/vocabulary.js'

/**
 * Every task move, and the only place one is decided. Routes, MCP tools, runner events and
 * the PR poller ask this table; none of them writes `state` on its own.
 */
export const MOVES = [
  'save_spec',
  'approve',
  'claim',
  'finish_review',
  'fail',
  'cancel',
  'rerun',
  'merge',
  'drag_done',
  'close_pr',
] as const
export type Move = (typeof MOVES)[number]

const TABLE: Record<Move, { from: readonly TaskState[]; to: TaskState }> = {
  save_spec: { from: ['backlog', 'spec_review'], to: 'spec_review' },
  approve: { from: ['spec_review'], to: 'ready' },
  claim: { from: ['ready'], to: 'running' },
  finish_review: { from: ['running'], to: 'review' },
  fail: { from: ['running'], to: 'failed' },
  cancel: { from: ['ready', 'running'], to: 'failed' },
  rerun: { from: ['failed'], to: 'ready' },
  merge: { from: ['review'], to: 'done' },
  drag_done: { from: ['review'], to: 'done' },
  close_pr: { from: ['review'], to: 'failed' },
}

export function nextState(from: TaskState, move: Move): TaskState | undefined {
  const row = TABLE[move]
  return row.from.includes(from) ? row.to : undefined
}
```

- [ ] **Step 4: Run it to see it pass, and check the core is pure**

Run: `npm run --workspace server test -- tests/unit/transitions.test.ts && grep -l "db/" server/src/modules/tasks/transitions.ts`
Expected: PASS; `grep` prints nothing (exit status 1 is the success here).

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): decide every task move in one table"
```

---

### Task 5: The spec parser and lint

**Files:**

- Create: `server/src/modules/specs/spec-parser.ts`
- Test: `server/tests/unit/spec-parser.test.ts`

**Interfaces:**

- Consumes: `SpecCriterion` from `shared/vocabulary.ts`.
- Produces: `parseSpec(markdown: string): ParsedSpec` with
  `ParsedSpec { requirements: { id: string; text: string }[]; criteria: SpecCriterion[];
openQuestions: string[]; findings: LintFinding[]; approvable: boolean }` and
  `LintFinding { code: LintCode; id?: string; text?: string }`, where `LintCode` is one of
  `no_requirements`, `requirement_without_id`, `criterion_without_id`,
  `criterion_without_requirement`, `requirement_without_criterion`, `unknown_requirement`,
  `duplicate_id`.

- [ ] **Step 1: Write the failing test**

`server/tests/unit/spec-parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseSpec } from '../../src/modules/specs/spec-parser.js'

const GOOD = `# Spec: Retry webhooks (PAY-42 · v1)

## Goal
Failed webhook deliveries are retried.

## Requirements
1. R1 – A failed delivery is retried with exponential backoff
2. R2 – After the last retry the delivery is marked dead

## Acceptance criteria
- AC1 (R1): Given a 500 When delivering Then it is retried after 1s, 2s and 4s
- AC2 (R2): Given four failures When the last fails Then the delivery is dead

## Open questions
`

describe('parseSpec on the template', () => {
  it('reads requirements, criteria and no open questions', () => {
    const spec = parseSpec(GOOD)
    expect(spec.requirements.map((r) => r.id)).toEqual(['R1', 'R2'])
    expect(spec.criteria).toEqual([
      {
        id: 'AC1',
        requirements: ['R1'],
        text: 'Given a 500 When delivering Then it is retried after 1s, 2s and 4s',
      },
      {
        id: 'AC2',
        requirements: ['R2'],
        text: 'Given four failures When the last fails Then the delivery is dead',
      },
    ])
    expect(spec.openQuestions).toEqual([])
    expect(spec.findings).toEqual([])
    expect(spec.approvable).toBe(true)
  })
})

/** Review Focus 1: a spec written elsewhere lints exactly like the template. */
describe('parseSpec on the same spec written differently', () => {
  it.each([
    ['CRLF line endings', GOOD.replaceAll('\n', '\r\n')],
    [
      'lower-case headings',
      GOOD.replace('## Acceptance criteria', '## acceptance criteria').replace(
        '## Requirements',
        '## requirements',
      ),
    ],
    ['star bullets', GOOD.replaceAll('- AC', '* AC')],
    ['a colon after the requirement id', GOOD.replace('R1 –', 'R1:').replace('R2 –', 'R2:')],
    ['a hyphen after the requirement id', GOOD.replace('R1 –', 'R1 -').replace('R2 –', 'R2 -')],
    [
      'bullets instead of numbers for requirements',
      GOOD.replace('1. R1', '- R1').replace('2. R2', '- R2'),
    ],
    ['trailing spaces', GOOD.replaceAll('\n', '   \n')],
  ])('%s', (_name, text) => {
    const spec = parseSpec(text)
    expect(spec.findings).toEqual([])
    expect(spec.requirements.map((r) => r.id)).toEqual(['R1', 'R2'])
    expect(spec.criteria.map((c) => c.id)).toEqual(['AC1', 'AC2'])
    expect(spec.approvable).toBe(true)
  })
})

describe('the lint', () => {
  it.each([
    [
      'a requirement without a criterion',
      GOOD.replace(/- AC2.*\n/, ''),
      [{ code: 'requirement_without_criterion', id: 'R2' }],
    ],
    [
      'a criterion naming a requirement that does not exist',
      GOOD.replace('AC2 (R2)', 'AC2 (R2, R9)'),
      [{ code: 'unknown_requirement', id: 'AC2', text: 'R9' }],
    ],
    [
      'a repeated requirement id',
      GOOD.replace('2. R2', '2. R1').replace('AC2 (R2)', 'AC2 (R1)'),
      [{ code: 'duplicate_id', id: 'R1' }],
    ],
    [
      'a criterion that names no requirement',
      GOOD.replace('AC2 (R2):', 'AC2 ():'),
      [
        { code: 'criterion_without_requirement', id: 'AC2' },
        { code: 'requirement_without_criterion', id: 'R2' },
      ],
    ],
    [
      'a requirement without an id',
      GOOD.replace('2. R2 – After', '2. After'),
      [
        {
          code: 'requirement_without_id',
          text: 'After the last retry the delivery is marked dead',
        },
        { code: 'unknown_requirement', id: 'AC2', text: 'R2' },
      ],
    ],
    [
      'a criterion without an id',
      GOOD.replace('- AC2 (R2): Given', '- Given'),
      [
        {
          code: 'criterion_without_id',
          text: 'Given four failures When the last fails Then the delivery is dead',
        },
        { code: 'requirement_without_criterion', id: 'R2' },
      ],
    ],
    [
      'no requirements section',
      GOOD.replace(/## Requirements[\s\S]*?(?=## Acceptance)/, ''),
      [
        { code: 'no_requirements' },
        { code: 'unknown_requirement', id: 'AC1', text: 'R1' },
        { code: 'unknown_requirement', id: 'AC2', text: 'R2' },
      ],
    ],
  ])('reports %s', (_name, text, findings) => {
    const spec = parseSpec(text)
    expect(spec.findings).toEqual(findings)
    expect(spec.approvable).toBe(false)
  })

  it('reads every criterion a requirement list names', () => {
    const spec = parseSpec(GOOD.replace('AC2 (R2)', 'AC2 (R1, R2)'))
    expect(spec.criteria[1]?.requirements).toEqual(['R1', 'R2'])
  })

  it('counts open questions and refuses approval while any remain', () => {
    const spec = parseSpec(`${GOOD}- Should a dead delivery alert anyone?\n- \n`)
    expect(spec.openQuestions).toEqual(['Should a dead delivery alert anyone?'])
    expect(spec.findings).toEqual([])
    expect(spec.approvable).toBe(false)
  })

  it('ignores prose that is not a list item inside a section', () => {
    const spec = parseSpec(
      GOOD.replace(
        '## Open questions\n',
        '## Open questions\nAll must be answered before approval.\n',
      ),
    )
    expect(spec.openQuestions).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run --workspace server test -- tests/unit/spec-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/modules/specs/spec-parser.ts`:

```ts
import type { SpecCriterion } from '../../shared/vocabulary.js'

export type LintCode =
  | 'no_requirements'
  | 'requirement_without_id'
  | 'criterion_without_id'
  | 'criterion_without_requirement'
  | 'requirement_without_criterion'
  | 'unknown_requirement'
  | 'duplicate_id'

export interface LintFinding {
  code: LintCode
  id?: string
  text?: string
}

export interface ParsedSpec {
  requirements: { id: string; text: string }[]
  criteria: SpecCriterion[]
  openQuestions: string[]
  findings: LintFinding[]
  /** The lint passes and no open question remains. */
  approvable: boolean
}

const HEADING = /^##\s+(.+?)\s*#*\s*$/
// A list item at the start of a line: `1.`, `1)`, `-`, `*` or `+`. Indented continuation lines
// are not items and are ignored.
const ITEM = /^(?:\d+[.)]|[-*+])\s+(.*)$/
const REQUIREMENT = /^(R\d+)\b\s*[–—:.)-]?\s*(.*)$/
const CRITERION = /^(AC\d+)\s*\(([^)]*)\)\s*[:.–—-]?\s*(.*)$/

/** The list items under each `## heading`, keyed by the heading in lower case. */
function sections(markdown: string): Map<string, string[]> {
  const result = new Map<string, string[]>()
  let current: string[] | undefined
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const heading = HEADING.exec(line)
    if (heading?.[1] !== undefined) {
      current = []
      result.set(heading[1].toLowerCase(), current)
      continue
    }
    if (current === undefined) continue
    const item = ITEM.exec(line)
    if (item?.[1] !== undefined) current.push(item[1].trim())
  }
  return result
}

export function parseSpec(markdown: string): ParsedSpec {
  const found = sections(markdown)
  const findings: LintFinding[] = []
  const seen = new Set<string>()
  const noteId = (id: string) => {
    if (seen.has(id)) findings.push({ code: 'duplicate_id', id })
    seen.add(id)
  }

  const requirements: { id: string; text: string }[] = []
  const requirementItems = found.get('requirements') ?? []
  if (requirementItems.length === 0) findings.push({ code: 'no_requirements' })
  for (const item of requirementItems) {
    const match = REQUIREMENT.exec(item)
    if (match?.[1] === undefined) {
      findings.push({ code: 'requirement_without_id', text: item })
      continue
    }
    noteId(match[1])
    requirements.push({ id: match[1], text: match[2] ?? '' })
  }

  const criteria: SpecCriterion[] = []
  for (const item of found.get('acceptance criteria') ?? []) {
    const match = CRITERION.exec(item)
    if (match?.[1] === undefined) {
      findings.push({ code: 'criterion_without_id', text: item })
      continue
    }
    noteId(match[1])
    const refs = (match[2] ?? '').split(/[,\s]+/).filter((ref) => /^R\d+$/.test(ref))
    if (refs.length === 0) findings.push({ code: 'criterion_without_requirement', id: match[1] })
    criteria.push({ id: match[1], requirements: refs, text: match[3] ?? '' })
  }

  const known = new Set(requirements.map((r) => r.id))
  for (const criterion of criteria) {
    for (const ref of criterion.requirements) {
      if (!known.has(ref))
        findings.push({ code: 'unknown_requirement', id: criterion.id, text: ref })
    }
  }
  const covered = new Set(criteria.flatMap((c) => c.requirements))
  for (const requirement of requirements) {
    if (
      !covered.has(requirement.id) &&
      !findings.some((f) => f.code === 'duplicate_id' && f.id === requirement.id)
    ) {
      findings.push({ code: 'requirement_without_criterion', id: requirement.id })
    }
  }

  const openQuestions = (found.get('open questions') ?? []).filter((q) => q !== '')

  return {
    requirements,
    criteria,
    openQuestions,
    findings,
    approvable: findings.length === 0 && openQuestions.length === 0,
  }
}
```

- [ ] **Step 4: Run it to see it pass, and check the core is pure**

Run: `npm run --workspace server test -- tests/unit/spec-parser.test.ts && grep -l "db/" server/src/modules/specs/spec-parser.ts`
Expected: PASS; `grep` prints nothing. If a row's expected `findings` disagrees with the
implementation's order, fix the implementation, not the row: findings are reported in the order
requirements → criteria → cross-references → coverage, which is the order the row lists them.

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): parse a spec and lint requirements against its criteria"
```

---

### Task 6: Pricing and the cost summary

**Files:**

- Create: `server/src/modules/costs/pricing.ts`, `server/src/modules/costs/summarize.ts`
- Test: `server/tests/unit/pricing.test.ts`, `server/tests/unit/summarize.test.ts`

**Interfaces:**

- Produces:
  - `Usage { input: number; output: number; cacheRead: number; cacheWrite: number }`,
    `ZERO_USAGE`, `addUsage(a, b): Usage`
  - `PriceRow { model: string; effectiveFrom: string /* YYYY-MM-DD */; input: number;
output: number; cacheRead: number; cacheWrite: number /* USD per million tokens */ }`
  - `priceAt(rows: PriceRow[], model: string, at: Date): PriceRow | undefined`
  - `costOf(usage: Usage, price: PriceRow): number`
  - `summarizeCosts(input: { events: CostEvent[]; phases: CostPhase[]; prices: PriceRow[] }): CostSummary`
    with `CostEvent { phaseId: string | null; agent: string | null; model: string | null; ts: Date; usage: Usage }`,
    `CostPhase { id: string; name: string; attempt: number; reportedCost: Record<string, number> | null }`,
    `CostSummary { totals: Line; byPhase: PhaseLine[]; byAgent: (Line & { agent: string })[];
byModel: (Line & { model: string })[]; cacheHitRatio: number | null; missingPrices: string[] }`,
    `Line { usage: Usage; usd: number }`,
    `PhaseLine = Line & { phaseId: string; name: string; attempt: number; reportedUsd: number | null; drift: number | null; flagged: boolean }`.
  - `DRIFT_LIMIT = 0.02`.

- [ ] **Step 1: Write the failing tests**

The prices below are fixtures chosen for arithmetic, not Anthropic's.

`server/tests/unit/pricing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { costOf, priceAt, type PriceRow } from '../../src/modules/costs/pricing.js'

const ROWS: PriceRow[] = [
  { model: 'm', effectiveFrom: '2026-01-01', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 },
  { model: 'm', effectiveFrom: '2026-06-01', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
  { model: 'other', effectiveFrom: '2026-01-01', input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
]

describe('priceAt', () => {
  it.each([
    ['before any row', '2025-12-31T23:59:59Z', undefined],
    ['on the first row’s day', '2026-01-01T00:00:00Z', '2026-01-01'],
    ['between rows', '2026-05-31T23:59:59Z', '2026-01-01'],
    ['on the second row’s day', '2026-06-01T00:00:00Z', '2026-06-01'],
    ['long after', '2027-01-01T00:00:00Z', '2026-06-01'],
  ])('%s', (_name, at, effectiveFrom) => {
    expect(priceAt(ROWS, 'm', new Date(at))?.effectiveFrom).toBe(effectiveFrom)
  })

  it('knows nothing of a model with no row', () => {
    expect(priceAt(ROWS, 'unknown', new Date('2026-07-01'))).toBeUndefined()
  })
})

describe('costOf', () => {
  const price = ROWS[0]!
  it.each([
    ['a million input tokens', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, 1],
    ['a million output tokens', { input: 0, output: 1e6, cacheRead: 0, cacheWrite: 0 }, 5],
    ['a million cache reads', { input: 0, output: 0, cacheRead: 1e6, cacheWrite: 0 }, 0.1],
    ['a million cache writes', { input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6 }, 2],
    [
      'all four at once',
      { input: 500_000, output: 200_000, cacheRead: 1e6, cacheWrite: 250_000 },
      0.5 + 1 + 0.1 + 0.5,
    ],
    ['nothing', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 0],
  ])('%s', (_name, usage, usd) => {
    expect(costOf(usage, price)).toBeCloseTo(usd, 10)
  })
})
```

`server/tests/unit/summarize.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  summarizeCosts,
  type CostEvent,
  type CostPhase,
} from '../../src/modules/costs/summarize.js'
import type { PriceRow } from '../../src/modules/costs/pricing.js'

const PRICES: PriceRow[] = [
  {
    model: 'big',
    effectiveFrom: '2026-01-01',
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 20,
  },
  {
    model: 'small',
    effectiveFrom: '2026-01-01',
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 2,
  },
]
const TS = new Date('2026-10-11T10:00:00Z')
const usage = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
})

const PHASES: CostPhase[] = [
  { id: 'p1', name: 'plan', attempt: 1, reportedCost: { big: 10 } },
  { id: 'p2', name: 'build', attempt: 1, reportedCost: { big: 5, small: 1 } },
]
const EVENTS: CostEvent[] = [
  { phaseId: 'p1', agent: 'planner', model: 'big', ts: TS, usage: usage(1e6) }, // $10
  { phaseId: 'p2', agent: 'builder', model: 'big', ts: TS, usage: usage(0, 100_000) }, // $5
  { phaseId: 'p2', agent: 'explorer', model: 'small', ts: TS, usage: usage(0, 0, 1e6) }, // $0.1
  { phaseId: 'p2', agent: 'claude-code', model: 'small', ts: TS, usage: usage(900_000) }, // $0.9
  { phaseId: 'p2', agent: 'runner', model: null, ts: TS, usage: usage(0) }, // a tool call
]

describe('summarizeCosts', () => {
  const summary = summarizeCosts({ events: EVENTS, phases: PHASES, prices: PRICES })

  it('totals every counter and the dollars', () => {
    expect(summary.totals.usage).toEqual(usage(1_900_000, 100_000, 1_000_000, 0))
    expect(summary.totals.usd).toBeCloseTo(16, 10)
  })

  it('splits by phase and compares each with what Claude Code reported', () => {
    expect(summary.byPhase).toEqual([
      expect.objectContaining({
        phaseId: 'p1',
        usd: 10,
        reportedUsd: 10,
        drift: 0,
        flagged: false,
      }),
      expect.objectContaining({ phaseId: 'p2', reportedUsd: 6, flagged: false }),
    ])
    // 5 + 0.1 + 0.9 in floating point: equal to 6 to ten places, not exactly.
    expect(summary.byPhase[1]?.usd).toBeCloseTo(6, 10)
    expect(summary.byPhase[1]?.drift).toBeCloseTo(0, 10)
  })

  it('splits by agent and by model, largest first', () => {
    expect(summary.byAgent.map((line) => line.agent)).toEqual([
      'planner',
      'builder',
      'claude-code',
      'explorer',
    ])
    expect(summary.byModel.map((line) => line.model)).toEqual(['big', 'small'])
  })

  it('reports the cache hit ratio as cache reads over all input', () => {
    expect(summary.cacheHitRatio).toBeCloseTo(1_000_000 / 2_900_000, 10)
  })

  it.each([
    ['just under the limit', 10 * 1.019, false],
    ['just over the limit', 10 * 1.021, true],
    ['under by more than the limit', 10 * 0.97, true],
  ])('flags a phase whose drift is %s', (_name, reported, flagged) => {
    const result = summarizeCosts({
      events: [EVENTS[0]!],
      phases: [{ ...PHASES[0]!, reportedCost: { big: reported } }],
      prices: PRICES,
    })
    expect(result.byPhase[0]?.flagged).toBe(flagged)
  })

  it('names a model with no price and leaves its phase uncompared', () => {
    const result = summarizeCosts({
      events: [{ ...EVENTS[0]!, model: 'new-model' }],
      phases: [PHASES[0]!],
      prices: PRICES,
    })
    expect(result.missingPrices).toEqual(['new-model'])
    expect(result.byPhase[0]).toMatchObject({ usd: 0, drift: null, flagged: false })
  })

  it('has no ratio and no phases for an empty run', () => {
    const result = summarizeCosts({ events: [], phases: [], prices: PRICES })
    expect(result.cacheHitRatio).toBeNull()
    expect(result.totals.usd).toBe(0)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run --workspace server test -- tests/unit/pricing.test.ts tests/unit/summarize.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`server/src/modules/costs/pricing.ts`:

```ts
export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

/** USD per million tokens, in effect from `effectiveFrom` (a UTC date) until a later row. */
export interface PriceRow {
  model: string
  effectiveFrom: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export function priceAt(rows: PriceRow[], model: string, at: Date): PriceRow | undefined {
  const day = at.toISOString().slice(0, 10)
  let best: PriceRow | undefined
  for (const row of rows) {
    if (row.model !== model || row.effectiveFrom > day) continue
    if (best === undefined || row.effectiveFrom > best.effectiveFrom) best = row
  }
  return best
}

export function costOf(usage: Usage, price: PriceRow): number {
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * price.cacheWrite) /
    1_000_000
  )
}
```

`server/src/modules/costs/summarize.ts`:

```ts
import { addUsage, costOf, priceAt, ZERO_USAGE, type PriceRow, type Usage } from './pricing.js'

/** Above this, a phase's computed cost and Claude Code's own disagree enough to say so. */
export const DRIFT_LIMIT = 0.02

export interface CostEvent {
  phaseId: string | null
  agent: string | null
  model: string | null
  ts: Date
  usage: Usage
}

export interface CostPhase {
  id: string
  name: string
  attempt: number
  reportedCost: Record<string, number> | null
}

export interface Line {
  usage: Usage
  usd: number
}

export type PhaseLine = Line & {
  phaseId: string
  name: string
  attempt: number
  reportedUsd: number | null
  drift: number | null
  flagged: boolean
}

export interface CostSummary {
  totals: Line
  byPhase: PhaseLine[]
  byAgent: (Line & { agent: string })[]
  byModel: (Line & { model: string })[]
  cacheHitRatio: number | null
  missingPrices: string[]
}

function accumulate(map: Map<string, Line>, key: string, usage: Usage, usd: number): void {
  const line = map.get(key) ?? { usage: ZERO_USAGE, usd: 0 }
  map.set(key, { usage: addUsage(line.usage, usage), usd: line.usd + usd })
}

const byUsd = <T extends Line>(a: T, b: T) => b.usd - a.usd

export function summarizeCosts(input: {
  events: CostEvent[]
  phases: CostPhase[]
  prices: PriceRow[]
}): CostSummary {
  const missing = new Set<string>()
  const unpricedPhases = new Set<string>()
  const phases = new Map<string, Line>()
  const agents = new Map<string, Line>()
  const models = new Map<string, Line>()
  let totals: Line = { usage: ZERO_USAGE, usd: 0 }

  for (const event of input.events) {
    if (event.model === null) continue
    const price = priceAt(input.prices, event.model, event.ts)
    if (price === undefined) {
      missing.add(event.model)
      if (event.phaseId !== null) unpricedPhases.add(event.phaseId)
    }
    const usd = price === undefined ? 0 : costOf(event.usage, price)
    totals = { usage: addUsage(totals.usage, event.usage), usd: totals.usd + usd }
    if (event.phaseId !== null) accumulate(phases, event.phaseId, event.usage, usd)
    accumulate(agents, event.agent ?? 'unknown', event.usage, usd)
    accumulate(models, event.model, event.usage, usd)
  }

  const byPhase: PhaseLine[] = input.phases.map((phase) => {
    const line = phases.get(phase.id) ?? { usage: ZERO_USAGE, usd: 0 }
    const reportedUsd =
      phase.reportedCost === null
        ? null
        : Object.values(phase.reportedCost).reduce((sum, usd) => sum + usd, 0)
    const comparable = reportedUsd !== null && reportedUsd > 0 && !unpricedPhases.has(phase.id)
    const drift = comparable ? Math.abs(line.usd - reportedUsd) / reportedUsd : null
    return {
      phaseId: phase.id,
      name: phase.name,
      attempt: phase.attempt,
      ...line,
      reportedUsd,
      drift,
      flagged: drift !== null && drift > DRIFT_LIMIT,
    }
  })

  const allInput = totals.usage.input + totals.usage.cacheRead + totals.usage.cacheWrite
  return {
    totals,
    byPhase,
    byAgent: [...agents].map(([agent, line]) => ({ agent, ...line })).sort(byUsd),
    byModel: [...models].map(([model, line]) => ({ model, ...line })).sort(byUsd),
    cacheHitRatio: allInput === 0 ? null : totals.usage.cacheRead / allInput,
    missingPrices: [...missing].sort(),
  }
}
```

- [ ] **Step 4: Run them to see them pass, and check the cores are pure**

Run: `npm run --workspace server test -- tests/unit/pricing.test.ts tests/unit/summarize.test.ts && grep -l "db/" server/src/modules/costs/pricing.ts server/src/modules/costs/summarize.ts`
Expected: PASS; `grep` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): price usage by date and compare it to Claude Code's cost"
```

---

## Phase C — the board's records

### Task 7: Projects — registering a target repository

**Files:**

- Create: `server/src/modules/projects/repo-inspector.ts`,
  `server/src/modules/projects/project.schemas.ts`, `project.repository.ts`,
  `project.service.ts`, `project.routes.ts`
- Modify: `server/src/app.ts` (decorate `repoInspector`, register the routes)
- Test: `server/tests/unit/github-remote.test.ts`, `server/tests/integration/repo-inspector.test.ts`,
  `server/tests/integration/projects.test.ts`

**Interfaces:**

- Produces: `RepoInspector { inspect(path: string): Promise<{ isGitRepo: boolean; remotes: string[] }>;
commandExists(command: string, cwd: string): Promise<boolean> }`,
  `createRepoInspector(): RepoInspector`, `matchesGithubRepo(remotes: string[], repo: string): boolean`;
  `ProjectView { id, key, name, repo_path, github_repo, base_branch, test_command }`;
  `GET /api/projects` → `ProjectView[]`; `POST /api/projects` → `201 ProjectView`.
- `AppDeps` gains `repoInspector?: RepoInspector` (default `createRepoInspector()`).

- [ ] **Step 1: Write the failing unit test**

`server/tests/unit/github-remote.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { matchesGithubRepo } from '../../src/modules/projects/repo-inspector.js'

describe('matchesGithubRepo', () => {
  it.each([
    ['https with .git', ['https://github.com/owner/pay.git'], true],
    ['https without .git', ['https://github.com/owner/pay'], true],
    ['ssh', ['git@github.com:owner/pay.git'], true],
    ['ssh url form', ['ssh://git@github.com/owner/pay.git'], true],
    ['different case', ['https://github.com/Owner/Pay.git'], true],
    [
      'one of several remotes',
      ['https://gitlab.com/x/y.git', 'git@github.com:owner/pay.git'],
      true,
    ],
    ['another repository', ['https://github.com/owner/payments.git'], false],
    ['another owner', ['https://github.com/someone/pay.git'], false],
    ['not GitHub', ['https://gitlab.com/owner/pay.git'], false],
    ['no remotes', [], false],
  ])('%s', (_name, remotes, expected) => {
    expect(matchesGithubRepo(remotes, 'owner/pay')).toBe(expected)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run --workspace server test -- tests/unit/github-remote.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the inspector**

`server/src/modules/projects/repo-inspector.ts`:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface RepoInspector {
  inspect(path: string): Promise<{ isGitRepo: boolean; remotes: string[] }>
  /** Whether the first word of `command` resolves to something runnable from `cwd`. */
  commandExists(command: string, cwd: string): Promise<boolean>
}

const GITHUB = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i

export function matchesGithubRepo(remotes: string[], repo: string): boolean {
  const wanted = repo.toLowerCase()
  return remotes.some((remote) => {
    const match = GITHUB.exec(remote.trim())
    return match !== null && `${match[1]}/${match[2]}`.toLowerCase() === wanted
  })
}

export function createRepoInspector(): RepoInspector {
  return {
    async inspect(path) {
      try {
        const inside = await run('git', ['-C', path, 'rev-parse', '--is-inside-work-tree'])
        if (inside.stdout.trim() !== 'true') return { isGitRepo: false, remotes: [] }
        const { stdout } = await run('git', ['-C', path, 'remote', '-v'])
        const remotes = stdout
          .split('\n')
          .map((line) => line.split(/\s+/)[1])
          .filter((url): url is string => url !== undefined && url !== '')
        return { isGitRepo: true, remotes: [...new Set(remotes)] }
      } catch {
        return { isGitRepo: false, remotes: [] }
      }
    },
    async commandExists(command, cwd) {
      const first = command.trim().split(/\s+/)[0]
      if (first === undefined || first === '') return false
      try {
        // `command -v` through a shell, so builtins, PATH lookups and ./scripts all resolve the
        // way they will when the runner runs the command.
        await run('sh', ['-c', 'command -v "$1"', 'sh', first], { cwd })
        return true
      } catch {
        return false
      }
    },
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm run --workspace server test -- tests/unit/github-remote.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing integration tests**

`server/tests/integration/repo-inspector.test.ts` — the real inspector against a real
repository on disk:

```ts
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
```

`server/tests/integration/projects.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, resetDb } from './helpers.js'
import type { RepoInspector } from '../../src/modules/projects/repo-inspector.js'

const fakeInspector: RepoInspector = {
  async inspect(path) {
    if (path === '/repos/pay') return { isGitRepo: true, remotes: ['git@github.com:owner/pay.git'] }
    if (path === '/repos/other')
      return { isGitRepo: true, remotes: ['git@github.com:owner/other.git'] }
    return { isGitRepo: false, remotes: [] }
  },
  async commandExists(command) {
    return command.startsWith('npm')
  },
}

const VALID = {
  key: 'PAY',
  name: 'Payments',
  repo_path: '/repos/pay',
  github_repo: 'owner/pay',
  base_branch: 'main',
  test_command: 'npm test',
}

let app: FastifyInstance
beforeAll(async () => {
  app = await buildTestApp({ repoInspector: fakeInspector })
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('POST /api/projects', () => {
  it('registers a target repository', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/projects', payload: VALID })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject(VALID)

    const list = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(list.json()).toEqual([expect.objectContaining({ key: 'PAY' })])
  })

  it.each([
    ['a path that is not a repository', { repo_path: '/repos/missing' }, 'repo_path'],
    ['a repository whose remote is another', { repo_path: '/repos/other' }, 'github_repo'],
    ['a test command that does not exist', { test_command: 'pnpm test' }, 'test_command'],
  ])('refuses %s, naming the field', async (_name, change, field) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { ...VALID, ...change },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'validation_error', details: { field } })
  })

  it.each([
    ['a lower-case key', { key: 'pay' }],
    ['a relative path', { repo_path: 'repos/pay' }],
    ['a repository without an owner', { github_repo: 'pay' }],
    ['a blank test command', { test_command: '   ' }],
    ['an unknown field', { colour: 'blue' }],
  ])('refuses %s at the schema', async (_name, change) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { ...VALID, ...change },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
  })

  it('refuses a second project with the same key', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: VALID })
    const response = await app.inject({ method: 'POST', url: '/api/projects', payload: VALID })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'validation_error', details: { field: 'key' } })
  })
})
```

- [ ] **Step 6: Run them to see them fail**

Run: `npm run --workspace server test -- tests/integration/repo-inspector.test.ts tests/integration/projects.test.ts`
Expected: the inspector suite PASSES (its code exists); the projects suite FAILS with 404s.

- [ ] **Step 7: Implement the module**

`server/src/modules/projects/project.schemas.ts`:

```ts
import { Type } from 'typebox'
import { NonBlankString } from '../../shared/schemas.js'

export const CreateProjectBody = Type.Object(
  {
    key: Type.String({ pattern: '^[A-Z][A-Z0-9]{1,9}$' }),
    name: NonBlankString({ maxLength: 100 }),
    repo_path: Type.String({ pattern: '^/', maxLength: 1000 }),
    github_repo: Type.String({ pattern: '^[^/\\s]+/[^/\\s]+$', maxLength: 200 }),
    base_branch: NonBlankString({ maxLength: 200 }),
    test_command: NonBlankString({ maxLength: 500 }),
  },
  { additionalProperties: false },
)
```

`server/src/modules/projects/project.repository.ts`:

```ts
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

export interface ProjectView {
  id: string
  key: string
  name: string
  repo_path: string
  github_repo: string
  base_branch: string
  test_command: string
}

const COLUMNS = [
  'id',
  'key',
  'name',
  'repo_path',
  'github_repo',
  'base_branch',
  'test_command',
] as const

export class ProjectRepository {
  constructor(private readonly db: Kysely<Database>) {}

  list(): Promise<ProjectView[]> {
    return this.db.selectFrom('projects').select(COLUMNS).orderBy('key').execute()
  }

  byKey(key: string): Promise<ProjectView | undefined> {
    return this.db.selectFrom('projects').select(COLUMNS).where('key', '=', key).executeTakeFirst()
  }

  async exists(key: string, repoPath: string): Promise<'key' | 'repo_path' | undefined> {
    const row = await this.db
      .selectFrom('projects')
      .select(['key', 'repo_path'])
      .where((eb) => eb.or([eb('key', '=', key), eb('repo_path', '=', repoPath)]))
      .executeTakeFirst()
    if (row === undefined) return undefined
    return row.key === key ? 'key' : 'repo_path'
  }

  insert(input: Omit<ProjectView, 'id'>): Promise<ProjectView> {
    return this.db.insertInto('projects').values(input).returning(COLUMNS).executeTakeFirstOrThrow()
  }
}
```

`server/src/modules/projects/project.service.ts`:

```ts
import { ValidationError } from '../../shared/errors.js'
import type { ProjectRepository, ProjectView } from './project.repository.js'
import { matchesGithubRepo, type RepoInspector } from './repo-inspector.js'

export class ProjectService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly inspector: RepoInspector,
  ) {}

  list(): Promise<ProjectView[]> {
    return this.repository.list()
  }

  /**
   * Checked here rather than on the first run: a wrong path or a test command that does not
   * exist would otherwise surface as a failed run, after tokens were spent finding out.
   */
  async create(input: Omit<ProjectView, 'id'>): Promise<ProjectView> {
    const taken = await this.repository.exists(input.key, input.repo_path)
    if (taken !== undefined) {
      throw new ValidationError(`A project already uses this ${taken.replace('_', ' ')}`, {
        field: taken,
      })
    }
    const repo = await this.inspector.inspect(input.repo_path)
    if (!repo.isGitRepo) {
      throw new ValidationError('repo_path is not a git repository', { field: 'repo_path' })
    }
    if (!matchesGithubRepo(repo.remotes, input.github_repo)) {
      throw new ValidationError('No remote of that repository points at github_repo', {
        field: 'github_repo',
        remotes: repo.remotes,
      })
    }
    if (!(await this.inspector.commandExists(input.test_command, input.repo_path))) {
      throw new ValidationError('The test command does not resolve in that repository', {
        field: 'test_command',
      })
    }
    return this.repository.insert(input)
  }
}
```

`server/src/modules/projects/project.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { ProjectRepository } from './project.repository.js'
import { ProjectService } from './project.service.js'
import { CreateProjectBody } from './project.schemas.js'

export function registerProjects(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new ProjectService(new ProjectRepository(app.db), app.repoInspector)

  app.get('/api/projects', async () => service.list())

  app.post('/api/projects', { schema: { body: CreateProjectBody } }, async (request, reply) => {
    reply.status(201)
    return service.create(request.body)
  })
}
```

In `server/src/app.ts`: add `repoInspector?: RepoInspector` to `AppDeps`, a `repoInspector:
RepoInspector` line to the `FastifyInstance` declaration, and, after `registerErrorHandler(app)`:

```ts
app.decorate('repoInspector', deps.repoInspector ?? createRepoInspector())
```

and after the health route:

```ts
registerProjects(app)
```

with the imports `import { createRepoInspector, type RepoInspector } from
'./modules/projects/repo-inspector.js'` and `import { registerProjects } from
'./modules/projects/project.routes.js'`.

- [ ] **Step 8: Run them to see them pass**

Run: `npm run --workspace server test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server
git commit -m "feat(server): register a target repository after checking it is one"
```

---

### Task 8: The notification bus and the browser's event stream

**Files:**

- Create: `server/src/shared/bus.ts`, `server/src/modules/stream/stream.routes.ts`
- Modify: `server/src/app.ts` (own the bus, register the stream)
- Test: `server/tests/integration/bus.test.ts`

**Interfaces:**

- Produces: `type BoardMessage = { topic: 'task.updated'; taskId: string } |
{ topic: 'run.queued'; runId: string } | { topic: 'run.event'; runId: string; taskId: string }`;
  `publish(db: Kysely<Database> | Transaction<Database>, message: BoardMessage): Promise<void>`;
  `class Bus { start(): Promise<void>; stop(): Promise<void>; subscribe(fn: (m: BoardMessage) => void): () => void;
next(topic: BoardMessage['topic'], timeoutMs: number): Promise<BoardMessage | undefined> }`;
  `app.bus`; `GET /api/stream` (server-sent events, one `event:` per message, `task.updated` and
  `run.event` only).

`pg_notify` inside a transaction is delivered at commit, so a message never announces a write
that was rolled back.

- [ ] **Step 1: Write the failing test**

`server/tests/integration/bus.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb } from './helpers.js'
import { publish } from '../../src/shared/bus.js'

let app: FastifyInstance
let base: string

beforeAll(async () => {
  app = await buildTestApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://localhost:${address.port}`
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('the bus', () => {
  it('delivers a published message to a subscriber', async () => {
    const received = app.bus.next('run.queued', 5_000)
    await publish(getTestDb(), { topic: 'run.queued', runId: 'r1' })
    expect(await received).toEqual({ topic: 'run.queued', runId: 'r1' })
  })

  it('delivers nothing from a transaction that rolled back', async () => {
    const received = app.bus.next('run.queued', 500)
    await getTestDb()
      .transaction()
      .execute(async (trx) => {
        await publish(trx, { topic: 'run.queued', runId: 'never' })
        throw new Error('roll back')
      })
      .catch(() => undefined)
    expect(await received).toBeUndefined()
  })
})

describe('GET /api/stream', () => {
  it('forwards task and run messages to the browser', async () => {
    const controller = new AbortController()
    const response = await fetch(`${base}/api/stream`, { signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    await new Promise((done) => setTimeout(done, 100))
    await publish(getTestDb(), { topic: 'task.updated', taskId: 't1' })

    let text = ''
    while (!text.includes('task.updated')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }
    controller.abort()
    expect(text).toContain('event: task.updated\ndata: {"topic":"task.updated","taskId":"t1"}\n\n')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run --workspace server test -- tests/integration/bus.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the bus**

`server/src/shared/bus.ts`:

```ts
import { sql, type Kysely, type Transaction } from 'kysely'
import pg from 'pg'
import type { Database } from '../db/schema.js'

export type BoardMessage =
  | { topic: 'task.updated'; taskId: string }
  | { topic: 'run.queued'; runId: string }
  | { topic: 'run.event'; runId: string; taskId: string }

const CHANNEL = 'board'

/** Delivered at commit when called inside a transaction, and never if it rolls back. */
export async function publish(
  db: Kysely<Database> | Transaction<Database>,
  message: BoardMessage,
): Promise<void> {
  await sql`select pg_notify(${CHANNEL}, ${JSON.stringify(message)})`.execute(db)
}

/** One dedicated connection listening on the channel, fanned out to in-process subscribers. */
export class Bus {
  private client: pg.Client | undefined
  private readonly subscribers = new Set<(message: BoardMessage) => void>()

  constructor(private readonly databaseUrl: string) {}

  async start(): Promise<void> {
    const client = new pg.Client({ connectionString: this.databaseUrl })
    await client.connect()
    client.on('notification', (notification) => {
      if (notification.channel !== CHANNEL || notification.payload === undefined) return
      const message = JSON.parse(notification.payload) as BoardMessage
      for (const subscriber of this.subscribers) subscriber(message)
    })
    await client.query(`listen ${CHANNEL}`)
    this.client = client
  }

  async stop(): Promise<void> {
    await this.client?.end()
    this.client = undefined
  }

  subscribe(subscriber: (message: BoardMessage) => void): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  /** The next message on `topic`, or `undefined` once `timeoutMs` passes. */
  next(topic: BoardMessage['topic'], timeoutMs: number): Promise<BoardMessage | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe()
        resolve(undefined)
      }, timeoutMs)
      const unsubscribe = this.subscribe((message) => {
        if (message.topic !== topic) return
        clearTimeout(timer)
        unsubscribe()
        resolve(message)
      })
    })
  }
}
```

`server/src/modules/stream/stream.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'

const FORWARDED = new Set(['task.updated', 'run.event'])

export function registerStream(app: FastifyInstance): void {
  app.get('/api/stream', (request, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    raw.write(': connected\n\n')

    const unsubscribe = app.bus.subscribe((message) => {
      if (!FORWARDED.has(message.topic)) return
      raw.write(`event: ${message.topic}\ndata: ${JSON.stringify(message)}\n\n`)
    })
    // A comment line every 15 s keeps proxies and the browser from timing the stream out.
    const keepAlive = setInterval(() => raw.write(': keep-alive\n\n'), 15_000)

    request.raw.on('close', () => {
      clearInterval(keepAlive)
      unsubscribe()
    })
  })
}
```

In `server/src/app.ts`: add `bus?: Bus` to `AppDeps` and `bus: Bus` to the `FastifyInstance`
declaration; after the `clock` decoration:

```ts
const bus = deps.bus ?? new Bus(deps.config.databaseUrl)
app.decorate('bus', bus)
app.addHook('onReady', async () => {
  if (deps.bus === undefined) await bus.start()
})
app.addHook('onClose', async () => {
  if (deps.bus === undefined) await bus.stop()
})
```

and `registerStream(app)` after `registerProjects(app)`, importing `Bus` from
`./shared/bus.js` and `registerStream` from `./modules/stream/stream.routes.js`.

- [ ] **Step 4: Run it to see it pass**

Run: `npm run --workspace server test`
Expected: PASS. `buildTestApp` makes the app ready, which starts the bus before any test
waits on it.

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): notify over postgres and stream changes to the browser"
```

---

### Task 9: Tasks — create, board, edit, and every move through the table

**Files:**

- Create: `server/src/modules/tasks/task.moves.ts`, `task.schemas.ts`, `task.repository.ts`,
  `task.service.ts`, `task.routes.ts`
- Modify: `server/src/app.ts` (register the routes)
- Test: `server/tests/integration/tasks.test.ts`, `server/tests/integration/fixtures.ts`

**Interfaces:**

- Consumes: `nextState`, `Move`, `publish`, `ConflictError`, `NotFoundError`.
- Produces:
  - `moveTask(db: Kysely<Database> | Transaction<Database>, taskId: string, move: Move): Promise<{ from: TaskState; to: TaskState }>`
    — locks the row, refuses with `409 conflict` when the table refuses, places the card last in
    its new column, publishes `task.updated`.
  - `TaskView { id, key, number, title, description_md, state, position, budget_usd: number | null,
project: { key, name, github_repo } }`;
    `TaskCard { id, key, title, state, position }` (Task 13 widens it).
  - `POST /api/projects/:key/tasks` `{ title, description_md?, budget_usd? }` → `201 TaskView`;
    `GET /api/projects/:key/tasks` → `{ project: ProjectView, tasks: TaskCard[] }`;
    `GET /api/tasks/:id` → `TaskView`;
    `PATCH /api/tasks/:id` `{ title?, description_md?, budget_usd?, position?, state?: 'done' }` → `TaskView`.
  - Test fixtures: `seedProject(db, overrides?)`, `seedTask(db, projectId, overrides?)`,
    `GOOD_SPEC`.

- [ ] **Step 1: Test fixtures**

`server/tests/integration/fixtures.ts`:

```ts
import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/schema.js'
import type { TaskState } from '../../src/shared/vocabulary.js'

/** The smallest spec that lints clean: one requirement, one criterion, no open question. */
export const GOOD_SPEC = `## Requirements
1. R1 – Retries back off
## Acceptance criteria
- AC1 (R1): Given a failure Then it retries after 1s
## Open questions
`

export async function seedProject(
  db: Kysely<Database>,
  overrides: Partial<{
    key: string
    repo_path: string
    github_repo: string
    test_command: string
  }> = {},
): Promise<{ id: string; key: string }> {
  return db
    .insertInto('projects')
    .values({
      key: 'PAY',
      name: 'Payments',
      repo_path: `/repos/${overrides.key ?? 'PAY'}`,
      github_repo: 'owner/pay',
      base_branch: 'main',
      test_command: 'npm test',
      ...overrides,
    })
    .returning(['id', 'key'])
    .executeTakeFirstOrThrow()
}

export async function seedTask(
  db: Kysely<Database>,
  projectId: string,
  overrides: Partial<{ title: string; state: TaskState; number: number; position: number }> = {},
): Promise<{ id: string }> {
  const number = overrides.number ?? 1
  await db
    .updateTable('projects')
    .set((eb) => ({
      next_task_number: eb.fn('greatest', [eb.ref('next_task_number'), eb.val(number + 1)]),
    }))
    .where('id', '=', projectId)
    .execute()
  return db
    .insertInto('tasks')
    .values({
      project_id: projectId,
      number,
      title: overrides.title ?? 'Retry webhooks',
      state: overrides.state ?? 'backlog',
      position: overrides.position ?? 1,
      updated_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}
```

- [ ] **Step 2: Write the failing test**

`server/tests/integration/tasks.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedProject, seedTask } from './fixtures.js'
import { moveTask } from '../../src/modules/tasks/task.moves.js'

let app: FastifyInstance
let projectId: string

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(async () => {
  await resetDb()
  projectId = (await seedProject(getTestDb())).id
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('POST /api/projects/:key/tasks', () => {
  it('creates a task in Backlog with the next number', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/projects/PAY/tasks',
      payload: { title: 'One' },
    })
    const second = await app.inject({
      method: 'POST',
      url: '/api/projects/PAY/tasks',
      payload: { title: 'Two', description_md: 'Why', budget_usd: 3 },
    })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({ key: 'PAY-1', state: 'backlog', budget_usd: null })
    expect(second.json()).toMatchObject({ key: 'PAY-2', description_md: 'Why', budget_usd: 3 })
  })

  it.each([
    ['a blank title', { title: '  ' }],
    ['a negative budget', { title: 'T', budget_usd: -1 }],
    ['a state', { title: 'T', state: 'done' }],
  ])('refuses %s', async (_name, payload) => {
    const response = await app.inject({ method: 'POST', url: '/api/projects/PAY/tasks', payload })
    expect(response.statusCode).toBe(400)
  })

  it('answers 404 for a project that does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/NOPE/tasks',
      payload: { title: 'T' },
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('GET /api/projects/:key/tasks', () => {
  it('lists the board, each column in its order', async () => {
    await seedTask(getTestDb(), projectId, { number: 1, title: 'B', position: 2 })
    await seedTask(getTestDb(), projectId, { number: 2, title: 'A', position: 1 })
    await seedTask(getTestDb(), projectId, { number: 3, title: 'R', state: 'review', position: 1 })
    const response = await app.inject({ method: 'GET', url: '/api/projects/PAY/tasks' })
    expect(response.json().tasks.map((t: { title: string }) => t.title)).toEqual(['A', 'B', 'R'])
  })
})

describe('PATCH /api/tasks/:id', () => {
  it('edits the title and the description', async () => {
    const { id } = await seedTask(getTestDb(), projectId)
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${id}`,
      payload: { title: 'Renamed', description_md: 'More' },
    })
    expect(response.json()).toMatchObject({ title: 'Renamed', description_md: 'More' })
  })

  it('reorders a card within its column', async () => {
    const { id } = await seedTask(getTestDb(), projectId)
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${id}`,
      payload: { position: 0.5 },
    })
    expect(response.json().position).toBe(0.5)
  })

  it('moves a card from Review to Done when dragged', async () => {
    const { id } = await seedTask(getTestDb(), projectId, { state: 'review' })
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${id}`,
      payload: { state: 'done' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().state).toBe('done')
  })

  // Review Focus 4: a drop on a card the runner moved since the board was drawn.
  it('answers 409 for a drag from any column but Review', async () => {
    const { id } = await seedTask(getTestDb(), projectId, { state: 'running' })
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${id}`,
      payload: { state: 'done' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      error: 'conflict',
      details: { state: 'running', move: 'drag_done' },
    })
  })

  it.each([
    ['any other state', { state: 'ready' }],
    ['nothing at all', {}],
  ])('refuses %s', async (_name, payload) => {
    const { id } = await seedTask(getTestDb(), projectId)
    const response = await app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload })
    expect(response.statusCode).toBe(400)
  })
})

describe('moveTask', () => {
  it('announces the move', async () => {
    const { id } = await seedTask(getTestDb(), projectId, { state: 'review' })
    const announced = app.bus.next('task.updated', 5_000)
    await moveTask(getTestDb(), id, 'merge')
    expect(await announced).toEqual({ topic: 'task.updated', taskId: id })
  })

  it('places a moved card last in its new column', async () => {
    await seedTask(getTestDb(), projectId, { number: 1, state: 'done', position: 7 })
    const { id } = await seedTask(getTestDb(), projectId, { number: 2, state: 'review' })
    await moveTask(getTestDb(), id, 'merge')
    const row = await getTestDb()
      .selectFrom('tasks')
      .select('position')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(row.position).toBe(8)
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm run --workspace server test -- tests/integration/tasks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`server/src/modules/tasks/task.moves.ts`:

```ts
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { ConflictError, NotFoundError } from '../../shared/errors.js'
import type { TaskState } from '../../shared/vocabulary.js'
import { nextState, type Move } from './transitions.js'

/**
 * The only writer of `tasks.state`. The row is locked first, so two movers — the owner's tab
 * and the runner — are serialised, and the loser gets a 409 rather than a lost update.
 */
export async function moveTask(
  db: Kysely<Database> | Transaction<Database>,
  taskId: string,
  move: Move,
): Promise<{ from: TaskState; to: TaskState }> {
  const task = await db
    .selectFrom('tasks')
    .select(['state', 'project_id'])
    .where('id', '=', taskId)
    .forUpdate()
    .executeTakeFirst()
  if (task === undefined) throw new NotFoundError('No such task')

  const to = nextState(task.state, move)
  if (to === undefined) {
    throw new ConflictError(`A task in ${task.state} cannot ${move.replaceAll('_', ' ')}`, {
      state: task.state,
      move,
    })
  }

  const { last } = await db
    .selectFrom('tasks')
    .select(sql<number>`coalesce(max(position), 0)`.as('last'))
    .where('project_id', '=', task.project_id)
    .where('state', '=', to)
    .executeTakeFirstOrThrow()

  await db
    .updateTable('tasks')
    .set({ state: to, position: last + 1, updated_at: new Date() })
    .where('id', '=', taskId)
    .execute()
  await publish(db, { topic: 'task.updated', taskId })
  return { from: task.state, to }
}
```

`server/src/modules/tasks/task.schemas.ts`:

```ts
import { Type } from 'typebox'
import { NonBlankString, Uuid } from '../../shared/schemas.js'

const Budget = Type.Number({ exclusiveMinimum: 0, maximum: 10_000 })

export const ProjectKeyParams = Type.Object({ key: Type.String({ maxLength: 10 }) })
export const TaskParams = Type.Object({ id: Uuid })

export const CreateTaskBody = Type.Object(
  {
    title: NonBlankString({ maxLength: 200 }),
    description_md: Type.Optional(Type.String({ maxLength: 100_000 })),
    budget_usd: Type.Optional(Budget),
  },
  { additionalProperties: false },
)

export const PatchTaskBody = Type.Object(
  {
    title: Type.Optional(NonBlankString({ maxLength: 200 })),
    description_md: Type.Optional(Type.String({ maxLength: 100_000 })),
    budget_usd: Type.Optional(Type.Union([Budget, Type.Null()])),
    position: Type.Optional(Type.Number()),
    // The one move a drag makes. Every other move is a button with its own endpoint.
    state: Type.Optional(Type.Literal('done')),
  },
  { additionalProperties: false, minProperties: 1 },
)
```

`server/src/modules/tasks/task.repository.ts`:

```ts
import { sql, type Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { TaskState } from '../../shared/vocabulary.js'

export interface TaskView {
  id: string
  key: string
  number: number
  title: string
  description_md: string
  state: TaskState
  position: number
  budget_usd: number | null
  project: { key: string; name: string; github_repo: string }
}

export interface TaskCard {
  id: string
  key: string
  title: string
  state: TaskState
  position: number
}

export class TaskRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async get(id: string): Promise<TaskView | undefined> {
    const row = await this.db
      .selectFrom('tasks')
      .innerJoin('projects', 'projects.id', 'tasks.project_id')
      .select([
        'tasks.id',
        'tasks.number',
        'tasks.title',
        'tasks.description_md',
        'tasks.state',
        'tasks.position',
        'tasks.budget_usd',
        'projects.key as project_key',
        'projects.name as project_name',
        'projects.github_repo',
      ])
      .where('tasks.id', '=', id)
      .executeTakeFirst()
    if (row === undefined) return undefined
    return {
      id: row.id,
      key: `${row.project_key}-${row.number}`,
      number: row.number,
      title: row.title,
      description_md: row.description_md,
      state: row.state,
      position: row.position,
      budget_usd: row.budget_usd === null ? null : Number(row.budget_usd),
      project: { key: row.project_key, name: row.project_name, github_repo: row.github_repo },
    }
  }

  async board(projectId: string, projectKey: string): Promise<TaskCard[]> {
    const rows = await this.db
      .selectFrom('tasks')
      .select(['id', 'number', 'title', 'state', 'position'])
      .where('project_id', '=', projectId)
      .orderBy('state')
      .orderBy('position')
      .orderBy('number')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      key: `${projectKey}-${row.number}`,
      title: row.title,
      state: row.state,
      position: row.position,
    }))
  }

  /** Takes the next number from the project row, so two creates never share one. */
  async insert(
    projectId: string,
    input: { title: string; description_md?: string | undefined; budget_usd?: number | undefined },
  ): Promise<string> {
    return this.db.transaction().execute(async (trx) => {
      const { number } = await trx
        .updateTable('projects')
        .set((eb) => ({ next_task_number: eb('next_task_number', '+', 1) }))
        .where('id', '=', projectId)
        .returning(sql<number>`next_task_number - 1`.as('number'))
        .executeTakeFirstOrThrow()
      const { last } = await trx
        .selectFrom('tasks')
        .select(sql<number>`coalesce(max(position), 0)`.as('last'))
        .where('project_id', '=', projectId)
        .where('state', '=', 'backlog')
        .executeTakeFirstOrThrow()
      const row = await trx
        .insertInto('tasks')
        .values({
          project_id: projectId,
          number,
          title: input.title,
          description_md: input.description_md ?? '',
          state: 'backlog',
          position: last + 1,
          budget_usd: input.budget_usd ?? null,
          updated_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return row.id
    })
  }

  async update(
    id: string,
    fields: {
      title?: string
      description_md?: string
      budget_usd?: number | null
      position?: number
    },
  ): Promise<void> {
    await this.db
      .updateTable('tasks')
      .set({ ...fields, updated_at: new Date() })
      .where('id', '=', id)
      .execute()
  }
}
```

`server/src/modules/tasks/task.service.ts`:

```ts
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { NotFoundError } from '../../shared/errors.js'
import type { ProjectRepository, ProjectView } from '../projects/project.repository.js'
import { moveTask } from './task.moves.js'
import type { TaskCard, TaskRepository, TaskView } from './task.repository.js'

export class TaskService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly tasks: TaskRepository,
    private readonly projects: ProjectRepository,
  ) {}

  private async project(key: string): Promise<ProjectView> {
    const project = await this.projects.byKey(key)
    if (project === undefined) throw new NotFoundError('No such project')
    return project
  }

  async get(id: string): Promise<TaskView> {
    const task = await this.tasks.get(id)
    if (task === undefined) throw new NotFoundError('No such task')
    return task
  }

  async board(key: string): Promise<{ project: ProjectView; tasks: TaskCard[] }> {
    const project = await this.project(key)
    return { project, tasks: await this.tasks.board(project.id, project.key) }
  }

  async create(
    key: string,
    input: { title: string; description_md?: string; budget_usd?: number },
  ): Promise<TaskView> {
    const project = await this.project(key)
    const id = await this.tasks.insert(project.id, input)
    await publish(this.db, { topic: 'task.updated', taskId: id })
    return this.get(id)
  }

  async patch(
    id: string,
    input: {
      title?: string
      description_md?: string
      budget_usd?: number | null
      position?: number
      state?: 'done'
    },
  ): Promise<TaskView> {
    await this.get(id)
    const { state, ...fields } = input
    if (state === 'done') await moveTask(this.db, id, 'drag_done')
    if (Object.keys(fields).length > 0) {
      await this.tasks.update(id, fields)
      await publish(this.db, { topic: 'task.updated', taskId: id })
    }
    return this.get(id)
  }
}
```

`server/src/modules/tasks/task.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { ProjectRepository } from '../projects/project.repository.js'
import { TaskRepository } from './task.repository.js'
import { CreateTaskBody, PatchTaskBody, ProjectKeyParams, TaskParams } from './task.schemas.js'
import { TaskService } from './task.service.js'

export function registerTasks(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new TaskService(app.db, new TaskRepository(app.db), new ProjectRepository(app.db))

  app.get('/api/projects/:key/tasks', { schema: { params: ProjectKeyParams } }, async (request) =>
    service.board(request.params.key),
  )

  app.post(
    '/api/projects/:key/tasks',
    { schema: { params: ProjectKeyParams, body: CreateTaskBody } },
    async (request, reply) => {
      reply.status(201)
      return service.create(request.params.key, request.body)
    },
  )

  app.get('/api/tasks/:id', { schema: { params: TaskParams } }, async (request) =>
    service.get(request.params.id),
  )

  app.patch(
    '/api/tasks/:id',
    { schema: { params: TaskParams, body: PatchTaskBody } },
    async (request) => service.patch(request.params.id, request.body),
  )
}
```

Register in `server/src/app.ts` after `registerProjects(app)`: `registerTasks(app)`.

- [ ] **Step 5: Run it to see it pass**

Run: `npm run --workspace server test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server
git commit -m "feat(server): create tasks and move them only by the transition table"
```

---

### Task 10: Specs — versions, lint, approval and the queued run

**Files:**

- Create: `server/src/modules/specs/spec.schemas.ts`, `spec.repository.ts`, `spec.service.ts`,
  `spec.routes.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/integration/specs.test.ts`

**Interfaces:**

- Consumes: `parseSpec`, `moveTask`, `publish`.
- Produces:
  - `SpecView { id, version, body_md, status, approved_at: string | null, lint: { requirements: string[];
criteria: SpecCriterion[]; open_questions: string[]; findings: LintFinding[]; approvable: boolean } }`
  - `GET /api/tasks/:id/specs` → `SpecView[]`, newest first;
    `POST /api/tasks/:id/specs` `{ body_md }` → `201 SpecView` (new version, older drafts
    superseded, task moved by `save_spec`);
    `POST /api/specs/:id/approve` → `{ spec: SpecView, run_id: string }` (task moved by
    `approve`, a `delivery` run queued, `run.queued` published).
  - `queueDeliveryRun(trx, taskId, specVersion): Promise<string>` — Task 14's Re-run uses it.

- [ ] **Step 1: Write the failing test**

`server/tests/integration/specs.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { GOOD_SPEC, seedProject, seedTask } from './fixtures.js'

let app: FastifyInstance
let taskId: string

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(async () => {
  await resetDb()
  const project = await seedProject(getTestDb())
  taskId = (await seedTask(getTestDb(), project.id)).id
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const save = (body_md: string) =>
  app.inject({ method: 'POST', url: `/api/tasks/${taskId}/specs`, payload: { body_md } })
const approve = (specId: string) =>
  app.inject({ method: 'POST', url: `/api/specs/${specId}/approve` })
const taskState = async () =>
  (
    await getTestDb()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
  ).state

describe('saving a spec', () => {
  it('stores version 1, lints it, and moves the card to Spec review', async () => {
    const response = await save(GOOD_SPEC)
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      version: 1,
      status: 'draft',
      lint: { requirements: ['R1'], open_questions: [], findings: [], approvable: true },
    })
    expect(await taskState()).toBe('spec_review')
  })

  it('makes each save a new version and supersedes the drafts before it', async () => {
    await save(GOOD_SPEC)
    const second = await save(`${GOOD_SPEC}- Is one second right?\n`)
    expect(second.json()).toMatchObject({ version: 2, lint: { approvable: false } })
    const list = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/specs` })
    expect(
      list.json().map((s: { version: number; status: string }) => [s.version, s.status]),
    ).toEqual([
      [2, 'draft'],
      [1, 'superseded'],
    ])
  })
})

describe('approving a spec', () => {
  it('freezes the version, moves the card to Ready and queues a delivery run', async () => {
    const spec = (await save(GOOD_SPEC)).json()
    const queued = app.bus.next('run.queued', 5_000)
    const response = await approve(spec.id)

    expect(response.statusCode).toBe(200)
    expect(response.json().spec).toMatchObject({
      status: 'approved',
      approved_at: expect.any(String),
    })
    expect(await taskState()).toBe('ready')
    const run = await getTestDb()
      .selectFrom('runs')
      .selectAll()
      .where('task_id', '=', taskId)
      .executeTakeFirstOrThrow()
    expect(run).toMatchObject({
      id: response.json().run_id,
      kind: 'delivery',
      spec_version: 1,
      status: 'queued',
    })
    expect(await queued).toEqual({ topic: 'run.queued', runId: run.id })
    const stored = await getTestDb()
      .selectFrom('specs')
      .select('criteria')
      .where('id', '=', spec.id)
      .executeTakeFirstOrThrow()
    expect(stored.criteria).toEqual([
      { id: 'AC1', requirements: ['R1'], text: 'Given a failure Then it retries after 1s' },
    ])
  })

  it('refuses a spec whose lint fails, listing the findings', async () => {
    const spec = (await save(GOOD_SPEC.replace(/- AC1.*\n/, ''))).json()
    const response = await approve(spec.id)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: 'validation_error',
      details: { findings: [{ code: 'requirement_without_criterion', id: 'R1' }] },
    })
    expect(await taskState()).toBe('spec_review')
  })

  it('refuses a spec with an open question', async () => {
    const spec = (await save(`${GOOD_SPEC}- Is one second right?\n`)).json()
    const response = await approve(spec.id)
    expect(response.statusCode).toBe(400)
    expect(response.json().details.open_questions).toEqual(['Is one second right?'])
  })

  // Review Focus 4: two tabs, one stale.
  it.each([
    [
      'a version already approved',
      async (first: string) => {
        await approve(first)
        return first
      },
    ],
    [
      'a version another save superseded',
      async (first: string) => {
        await save(GOOD_SPEC)
        return first
      },
    ],
  ])('answers 409 for %s', async (_name, arrange) => {
    const first = (await save(GOOD_SPEC)).json().id
    const target = await arrange(first)
    const response = await approve(target)
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('conflict')
  })

  it('refuses a new version once the spec is approved', async () => {
    const spec = (await save(GOOD_SPEC)).json()
    await approve(spec.id)
    const response = await save(GOOD_SPEC)
    expect(response.statusCode).toBe(409)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run --workspace server test -- tests/integration/specs.test.ts`
Expected: FAIL — 404s.

- [ ] **Step 3: Implement**

`server/src/modules/specs/spec.schemas.ts`:

```ts
import { Type } from 'typebox'
import { NonBlankString, Uuid } from '../../shared/schemas.js'

export const SpecParams = Type.Object({ id: Uuid })
export const SaveSpecBody = Type.Object(
  { body_md: NonBlankString({ maxLength: 100_000 }) },
  { additionalProperties: false },
)
```

`server/src/modules/specs/spec.repository.ts`:

```ts
import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { SpecCriterion } from '../../shared/vocabulary.js'

export interface SpecRow {
  id: string
  task_id: string
  version: number
  body_md: string
  status: 'draft' | 'approved' | 'superseded'
  approved_at: Date | null
}

type Db = Kysely<Database> | Transaction<Database>
const COLUMNS = ['id', 'task_id', 'version', 'body_md', 'status', 'approved_at'] as const

export class SpecRepository {
  constructor(private readonly db: Kysely<Database>) {}

  list(taskId: string): Promise<SpecRow[]> {
    return this.db
      .selectFrom('specs')
      .select(COLUMNS)
      .where('task_id', '=', taskId)
      .orderBy('version', 'desc')
      .execute()
  }

  get(db: Db, id: string): Promise<SpecRow | undefined> {
    return db
      .selectFrom('specs')
      .select(COLUMNS)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
  }

  async latestVersion(db: Db, taskId: string): Promise<number> {
    const row = await db
      .selectFrom('specs')
      .select((eb) => eb.fn.max('version').as('version'))
      .where('task_id', '=', taskId)
      .executeTakeFirst()
    return row?.version ?? 0
  }

  async insertVersion(db: Db, taskId: string, body: string): Promise<SpecRow> {
    const version = (await this.latestVersion(db, taskId)) + 1
    await db
      .updateTable('specs')
      .set({ status: 'superseded' })
      .where('task_id', '=', taskId)
      .where('status', '=', 'draft')
      .execute()
    return db
      .insertInto('specs')
      .values({
        task_id: taskId,
        version,
        body_md: body,
        status: 'draft',
        criteria: null,
        approved_at: null,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow()
  }

  async approve(db: Db, id: string, criteria: SpecCriterion[], at: Date): Promise<void> {
    await db
      .updateTable('specs')
      .set({ status: 'approved', criteria: JSON.stringify(criteria), approved_at: at })
      .where('id', '=', id)
      .execute()
  }
}
```

`server/src/modules/specs/spec.service.ts`:

```ts
import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js'
import type { SpecCriterion } from '../../shared/vocabulary.js'
import { moveTask } from '../tasks/task.moves.js'
import { parseSpec, type LintFinding } from './spec-parser.js'
import type { SpecRepository, SpecRow } from './spec.repository.js'

export interface SpecView {
  id: string
  version: number
  body_md: string
  status: SpecRow['status']
  approved_at: string | null
  lint: {
    requirements: string[]
    criteria: SpecCriterion[]
    open_questions: string[]
    findings: LintFinding[]
    approvable: boolean
  }
}

export function toSpecView(row: SpecRow): SpecView {
  const parsed = parseSpec(row.body_md)
  return {
    id: row.id,
    version: row.version,
    body_md: row.body_md,
    status: row.status,
    approved_at: row.approved_at?.toISOString() ?? null,
    lint: {
      requirements: parsed.requirements.map((r) => r.id),
      criteria: parsed.criteria,
      open_questions: parsed.openQuestions,
      findings: parsed.findings,
      approvable: parsed.approvable,
    },
  }
}

export async function queueDeliveryRun(
  trx: Transaction<Database>,
  taskId: string,
  specVersion: number,
): Promise<string> {
  const run = await trx
    .insertInto('runs')
    .values({ task_id: taskId, kind: 'delivery', spec_version: specVersion, status: 'queued' })
    .returning('id')
    .executeTakeFirstOrThrow()
  await publish(trx, { topic: 'run.queued', runId: run.id })
  return run.id
}

export class SpecService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly specs: SpecRepository,
    private readonly clock: () => Date,
  ) {}

  async list(taskId: string): Promise<SpecView[]> {
    return (await this.specs.list(taskId)).map(toSpecView)
  }

  async save(taskId: string, body: string): Promise<SpecView> {
    const row = await this.db.transaction().execute(async (trx) => {
      await moveTask(trx, taskId, 'save_spec')
      return this.specs.insertVersion(trx, taskId, body)
    })
    return toSpecView(row)
  }

  async approve(specId: string): Promise<{ spec: SpecView; run_id: string }> {
    return this.db.transaction().execute(async (trx) => {
      const spec = await this.specs.get(trx, specId)
      if (spec === undefined) throw new NotFoundError('No such spec')
      if (spec.status !== 'draft') {
        throw new ConflictError(`This version is ${spec.status}; reload to see the latest`, {
          status: spec.status,
        })
      }
      const parsed = parseSpec(spec.body_md)
      if (!parsed.approvable) {
        throw new ValidationError('The spec cannot be approved yet', {
          findings: parsed.findings,
          open_questions: parsed.openQuestions,
        })
      }
      await moveTask(trx, spec.task_id, 'approve')
      const at = this.clock()
      await this.specs.approve(trx, spec.id, parsed.criteria, at)
      const runId = await queueDeliveryRun(trx, spec.task_id, spec.version)
      return { spec: toSpecView({ ...spec, status: 'approved', approved_at: at }), run_id: runId }
    })
  }
}
```

`server/src/modules/specs/spec.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { TaskParams } from '../tasks/task.schemas.js'
import { SaveSpecBody, SpecParams } from './spec.schemas.js'
import { SpecRepository } from './spec.repository.js'
import { SpecService } from './spec.service.js'

export function registerSpecs(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new SpecService(app.db, new SpecRepository(app.db), app.clock)

  app.get('/api/tasks/:id/specs', { schema: { params: TaskParams } }, async (request) =>
    service.list(request.params.id),
  )

  app.post(
    '/api/tasks/:id/specs',
    { schema: { params: TaskParams, body: SaveSpecBody } },
    async (request, reply) => {
      reply.status(201)
      return service.save(request.params.id, request.body.body_md)
    },
  )

  app.post('/api/specs/:id/approve', { schema: { params: SpecParams } }, async (request) =>
    service.approve(request.params.id),
  )
}
```

Register in `server/src/app.ts` after `registerTasks(app)`: `registerSpecs(app)`.

- [ ] **Step 4: Run it to see it pass**

Run: `npm run --workspace server test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): version specs, lint them, and queue a run on approval"
```

---

## Phase D — runs on the server

### Task 11: The runner's endpoints — claim, heartbeat, tokens, and events that move the board

**Files:**

- Create: `server/src/shared/tokens.ts`, `server/src/modules/runner/runner.schemas.ts`,
  `server/src/modules/runner/event-effects.ts`, `runner.service.ts`, `runner.routes.ts`
- Modify: `server/src/app.ts`, `server/tests/integration/fixtures.ts`
- Test: `server/tests/unit/event-effects.test.ts`, `server/tests/unit/tokens.test.ts`,
  `server/tests/integration/runner.test.ts`

**Interfaces:**

- Consumes: `moveTask`, `publish`, `Bus.next`, `UnauthorizedError`, `ConflictError`.
- Produces:
  - `newToken(): { token: string; hash: string }`, `hashToken(token): string`,
    `bearer(header?: string): string | undefined`, `sameSecret(a: string, b: string): boolean`,
    `resolveRunToken(db, header: string | undefined, now: Date): Promise<{ runId: string; taskId: string }>`.
  - `RunnerEvent` (TypeBox `RunnerEventSchema`) — the wire event:
    `{ id: uuid; run_id: uuid; phase_id: uuid | null; ts: date-time; type: EventType;
agent: string | null; model: string | null; tool: string | null; target: string | null;
status: string | null; duration_ms: number | null;
usage: { input; output; cache_read; cache_write }; payload: Record<string, unknown> }`.
  - Payload contracts the runner must follow:
    - `phase_start`: `payload { name: PhaseName; attempt: number; session_id?: string }`, with
      `agent` and `model` set on the event.
    - `phase_end`: `payload { status: 'succeeded' | 'failed'; summary_md?: string;
reported_cost?: Record<string, number>; session_id?: string }`.
    - `run_end`: `payload { outcome: 'review' | 'failed' | 'cancelled'; reason?: string;
pr_number?: number; pr_url?: string; branch?: string; worktree_path?: string }`.
  - `effectOf(event: RunnerEvent): Effect | undefined` (pure).
  - `Work { kind: 'start'; run: { id; number; kind; spec_version; task: { id; key; title;
description_md; budget_usd: number | null }; spec: { version; body_md; criteria: SpecCriterion[] };
project: { key; repo_path; github_repo; base_branch; test_command } } }`.
  - Routes: `POST /api/runner/claim` `{ runner_id, wait_ms? }` → `{ work: Work | null }`;
    `POST /api/runner/heartbeat` `{ runner_id, run_ids }` → `{ cancel: string[] }`;
    `POST /api/runner/runs/:id/tokens` → `{ token }` (all three: `Authorization: Bearer <RUNNER_KEY>`);
    `POST /api/runner/events` `{ events: RunnerEvent[] }` → `{ accepted: number }`;
    `POST /api/runner/tokens/retire` → `204` (both: `Authorization: Bearer <run token>`).
  - Fixture `seedQueuedRun(db, overrides?)` → `{ projectId, taskId, runId }`.

- [ ] **Step 1: Write the failing unit tests**

`server/tests/unit/tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { bearer, hashToken, newToken, sameSecret } from '../../src/shared/tokens.js'

describe('tokens', () => {
  it('issues a token whose hash is what is stored', () => {
    const { token, hash } = newToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(hashToken(token)).toBe(hash)
    expect(newToken().token).not.toBe(token)
  })

  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['Bearer', undefined],
    ['Basic abc', undefined],
    [undefined, undefined],
  ])('bearer(%s) → %s', (header, expected) => {
    expect(bearer(header)).toBe(expected)
  })

  it.each([
    ['equal', 'k'.repeat(40), 'k'.repeat(40), true],
    ['different', 'k'.repeat(40), 'j'.repeat(40), false],
    ['different lengths', 'k'.repeat(40), 'k'.repeat(39), false],
  ])('sameSecret: %s', (_name, a, b, expected) => {
    expect(sameSecret(a, b)).toBe(expected)
  })
})
```

`server/tests/unit/event-effects.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { effectOf } from '../../src/modules/runner/event-effects.js'
import type { RunnerEvent } from '../../src/modules/runner/runner.schemas.js'

const TS = '2026-10-11T10:00:00.000Z'
function event(
  type: RunnerEvent['type'],
  payload: Record<string, unknown>,
  extra: Partial<RunnerEvent> = {},
): RunnerEvent {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    run_id: '00000000-0000-4000-8000-000000000002',
    phase_id: '00000000-0000-4000-8000-000000000003',
    ts: TS,
    type,
    agent: 'planner',
    model: 'claude-sonnet-x',
    tool: null,
    target: null,
    status: null,
    duration_ms: null,
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    payload,
    ...extra,
  }
}

describe('effectOf', () => {
  it('reads a phase start', () => {
    expect(effectOf(event('phase_start', { name: 'plan', attempt: 1, session_id: 's' }))).toEqual({
      kind: 'phase_start',
      phaseId: '00000000-0000-4000-8000-000000000003',
      name: 'plan',
      attempt: 1,
      agent: 'planner',
      model: 'claude-sonnet-x',
      sessionId: 's',
      at: new Date(TS),
    })
  })

  it('reads a phase end with the cost Claude Code reported', () => {
    expect(
      effectOf(
        event('phase_end', { status: 'succeeded', summary_md: 'Done', reported_cost: { m: 0.5 } }),
      ),
    ).toEqual({
      kind: 'phase_end',
      phaseId: '00000000-0000-4000-8000-000000000003',
      status: 'succeeded',
      summary: 'Done',
      reportedCost: { m: 0.5 },
      sessionId: null,
      at: new Date(TS),
    })
  })

  it('reads a run end with its pull request', () => {
    expect(
      effectOf(
        event(
          'run_end',
          {
            outcome: 'review',
            pr_number: 7,
            pr_url: 'https://github.com/o/r/pull/7',
            branch: 'board/PAY-1-r1',
          },
          { phase_id: null },
        ),
      ),
    ).toEqual({
      kind: 'run_end',
      outcome: 'review',
      reason: null,
      prNumber: 7,
      prUrl: 'https://github.com/o/r/pull/7',
      branch: 'board/PAY-1-r1',
      worktreePath: null,
      at: new Date(TS),
    })
  })

  it.each(['message', 'tool_call', 'subagent_start', 'error'] as const)(
    'has no effect for %s',
    (type) => {
      expect(effectOf(event(type, {}))).toBeUndefined()
    },
  )

  it.each([
    [
      'a phase start with no phase id',
      event('phase_start', { name: 'plan', attempt: 1 }, { phase_id: null }),
    ],
    ['a phase start for an unknown phase', event('phase_start', { name: 'deploy', attempt: 1 })],
    ['a phase start with attempt zero', event('phase_start', { name: 'plan', attempt: 0 })],
    [
      'a phase start with no agent',
      event('phase_start', { name: 'plan', attempt: 1 }, { agent: null }),
    ],
    ['a phase end with an unknown status', event('phase_end', { status: 'paused' })],
    [
      'a phase end whose cost is not a number',
      event('phase_end', { status: 'failed', reported_cost: { m: 'x' } }),
    ],
    ['a run end with an unknown outcome', event('run_end', { outcome: 'merged' })],
    ['a review without a pull request', event('run_end', { outcome: 'review' })],
  ])('refuses %s', (_name, input) => {
    expect(() => effectOf(input)).toThrow(/payload/)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run --workspace server test -- tests/unit/tokens.test.ts tests/unit/event-effects.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement tokens, schemas and effects**

`server/src/shared/tokens.ts`:

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { UnauthorizedError } from './errors.js'

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

export function bearer(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  return match?.[1]
}

/** Compares digests, so neither the length nor the content leaks through timing. */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  )
}

/** Every failure is the same `UnauthorizedError`: no hint whether the token exists. */
export async function resolveRunToken(
  db: Kysely<Database>,
  header: string | undefined,
  now: Date,
): Promise<{ runId: string; taskId: string }> {
  const token = bearer(header)
  if (token === undefined) throw new UnauthorizedError()
  const row = await db
    .selectFrom('run_tokens')
    .innerJoin('runs', 'runs.id', 'run_tokens.run_id')
    .select(['runs.id as runId', 'runs.task_id as taskId', 'run_tokens.expires_at'])
    .where('run_tokens.token_hash', '=', hashToken(token))
    .executeTakeFirst()
  if (row === undefined || row.expires_at <= now) throw new UnauthorizedError()
  return { runId: row.runId, taskId: row.taskId }
}
```

`server/src/modules/runner/runner.schemas.ts`:

```ts
import { Type, type Static } from 'typebox'
import { NonBlankString, Uuid } from '../../shared/schemas.js'
import { EVENT_TYPES } from '../../shared/vocabulary.js'

const NullableString = (maxLength: number) => Type.Union([Type.String({ maxLength }), Type.Null()])
const Count = Type.Integer({ minimum: 0 })

export const RunnerEventSchema = Type.Object(
  {
    id: Uuid,
    run_id: Uuid,
    phase_id: Type.Union([Uuid, Type.Null()]),
    ts: Type.String({ format: 'date-time' }),
    type: Type.Enum(EVENT_TYPES),
    agent: NullableString(100),
    model: NullableString(200),
    tool: NullableString(200),
    target: NullableString(2000),
    status: NullableString(50),
    duration_ms: Type.Union([Count, Type.Null()]),
    usage: Type.Object(
      { input: Count, output: Count, cache_read: Count, cache_write: Count },
      { additionalProperties: false },
    ),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
)
export type RunnerEvent = Static<typeof RunnerEventSchema>

export const EventsBody = Type.Object(
  { events: Type.Array(RunnerEventSchema, { minItems: 1, maxItems: 500 }) },
  { additionalProperties: false },
)

export const ClaimBody = Type.Object(
  {
    runner_id: NonBlankString({ maxLength: 100 }),
    wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })),
  },
  { additionalProperties: false },
)

export const HeartbeatBody = Type.Object(
  { runner_id: NonBlankString({ maxLength: 100 }), run_ids: Type.Array(Uuid, { maxItems: 50 }) },
  { additionalProperties: false },
)

export const RunParams = Type.Object({ id: Uuid })
```

`server/src/modules/runner/event-effects.ts`:

```ts
import { ValidationError } from '../../shared/errors.js'
import { PHASE_NAMES, type PhaseName } from '../../shared/vocabulary.js'
import type { RunnerEvent } from './runner.schemas.js'

export type Effect =
  | {
      kind: 'phase_start'
      phaseId: string
      name: PhaseName
      attempt: number
      agent: string
      model: string
      sessionId: string | null
      at: Date
    }
  | {
      kind: 'phase_end'
      phaseId: string
      status: 'succeeded' | 'failed'
      summary: string | null
      reportedCost: Record<string, number> | null
      sessionId: string | null
      at: Date
    }
  | {
      kind: 'run_end'
      outcome: 'review' | 'failed' | 'cancelled'
      reason: string | null
      prNumber: number | null
      prUrl: string | null
      branch: string | null
      worktreePath: string | null
      at: Date
    }

function bad(event: RunnerEvent, why: string): never {
  throw new ValidationError(`Invalid ${event.type} payload: ${why}`, { event_id: event.id })
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function costMap(event: RunnerEvent, value: unknown): Record<string, number> | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') bad(event, 'reported_cost must be an object')
  const result: Record<string, number> = {}
  for (const [model, usd] of Object.entries(value)) {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0)
      bad(event, `reported_cost.${model} is not a cost`)
    result[model] = usd
  }
  return result
}

/** What a stored event changes beyond its own row. Pure: the service applies it. */
export function effectOf(event: RunnerEvent): Effect | undefined {
  const p = event.payload
  const at = new Date(event.ts)
  switch (event.type) {
    case 'phase_start': {
      const { phase_id: phaseId, agent, model } = event
      const name = PHASE_NAMES.find((known) => known === p.name)
      const attempt = typeof p.attempt === 'number' && Number.isInteger(p.attempt) ? p.attempt : 0
      if (phaseId === null) bad(event, 'phase_id is required')
      if (name === undefined) bad(event, 'name is not a phase')
      if (attempt < 1) bad(event, 'attempt must be 1 or more')
      if (agent === null || model === null) bad(event, 'agent and model are required')
      return {
        kind: 'phase_start',
        phaseId,
        name,
        attempt,
        agent,
        model,
        sessionId: text(p.session_id),
        at,
      }
    }
    case 'phase_end': {
      const phaseId = event.phase_id
      const status = p.status === 'succeeded' || p.status === 'failed' ? p.status : undefined
      if (phaseId === null) bad(event, 'phase_id is required')
      if (status === undefined) bad(event, 'status must be succeeded or failed')
      return {
        kind: 'phase_end',
        phaseId,
        status,
        summary: text(p.summary_md),
        reportedCost: costMap(event, p.reported_cost),
        sessionId: text(p.session_id),
        at,
      }
    }
    case 'run_end': {
      const outcome =
        p.outcome === 'review' || p.outcome === 'failed' || p.outcome === 'cancelled'
          ? p.outcome
          : undefined
      if (outcome === undefined) bad(event, 'outcome must be review, failed or cancelled')
      const prNumber =
        typeof p.pr_number === 'number' && Number.isInteger(p.pr_number) ? p.pr_number : null
      const prUrl = text(p.pr_url)
      if (outcome === 'review' && (prNumber === null || prUrl === null))
        bad(event, 'a review needs pr_number and pr_url')
      return {
        kind: 'run_end',
        outcome,
        reason: text(p.reason),
        prNumber,
        prUrl,
        branch: text(p.branch),
        worktreePath: text(p.worktree_path),
        at,
      }
    }
    default:
      return undefined
  }
}
```

- [ ] **Step 4: Run the unit tests to see them pass**

Run: `npm run --workspace server test -- tests/unit/tokens.test.ts tests/unit/event-effects.test.ts && grep -l "db/" server/src/modules/runner/event-effects.ts`
Expected: PASS; `grep` prints nothing.

- [ ] **Step 5: Write the failing integration test**

Add to `server/tests/integration/fixtures.ts`:

```ts
/** A project, a task in Ready with an approved spec, and its queued delivery run. */
export async function seedQueuedRun(
  db: Kysely<Database>,
  overrides: Partial<{ state: TaskState; projectKey: string }> = {},
): Promise<{ projectId: string; taskId: string; runId: string }> {
  const project = await seedProject(db, { key: overrides.projectKey ?? 'PAY' })
  const task = await seedTask(db, project.id, { state: overrides.state ?? 'ready' })
  await db
    .insertInto('specs')
    .values({
      task_id: task.id,
      version: 1,
      body_md: GOOD_SPEC,
      status: 'approved',
      approved_at: new Date(),
      criteria: JSON.stringify([
        { id: 'AC1', requirements: ['R1'], text: 'Given a failure Then it retries after 1s' },
      ]),
    })
    .execute()
  const run = await db
    .insertInto('runs')
    .values({ task_id: task.id, kind: 'delivery', spec_version: 1, status: 'queued' })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { projectId: project.id, taskId: task.id, runId: run.id }
}
```

`server/tests/integration/runner.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'
import { publish } from '../../src/shared/bus.js'

let app: FastifyInstance
let now = new Date('2026-10-11T10:00:00Z')
const auth = { authorization: `Bearer ${TEST_RUNNER_KEY}` }

beforeAll(async () => {
  app = await buildTestApp({ clock: () => now })
})
beforeEach(async () => {
  await resetDb()
  now = new Date('2026-10-11T10:00:00Z')
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const claim = (wait_ms = 0) =>
  app.inject({
    method: 'POST',
    url: '/api/runner/claim',
    headers: auth,
    payload: { runner_id: 'r1', wait_ms },
  })

async function claimed() {
  const seeded = await seedQueuedRun(getTestDb())
  await claim()
  const token = (
    await app.inject({
      method: 'POST',
      url: `/api/runner/runs/${seeded.runId}/tokens`,
      headers: auth,
    })
  ).json().token as string
  return { ...seeded, token }
}

function event(
  runId: string,
  type: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id: crypto.randomUUID(),
    run_id: runId,
    phase_id: null,
    ts: now.toISOString(),
    type,
    agent: null,
    model: null,
    tool: null,
    target: null,
    status: null,
    duration_ms: null,
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    payload,
    ...extra,
  }
}

const send = (token: string, events: unknown[]) =>
  app.inject({
    method: 'POST',
    url: '/api/runner/events',
    headers: { authorization: `Bearer ${token}` },
    payload: { events },
  })

const state = async (taskId: string) =>
  (
    await getTestDb()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
  ).state

describe('the runner key', () => {
  it.each([
    ['no header', {}],
    ['the wrong key', { authorization: `Bearer ${'x'.repeat(40)}` }],
    ['another scheme', { authorization: `Basic ${TEST_RUNNER_KEY}` }],
  ])('answers %s with one identical 401', async (_name, headers) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/runner/claim',
      headers,
      payload: { runner_id: 'r1' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: 'unauthorized',
      message: 'Missing or invalid credential',
    })
  })
})

describe('POST /api/runner/claim', () => {
  it('answers no work when nothing is queued', async () => {
    expect((await claim()).json()).toEqual({ work: null })
  })

  it('hands over the oldest queued run with everything the runner needs, once', async () => {
    const { taskId, runId } = await seedQueuedRun(getTestDb())
    const work = (await claim()).json().work
    expect(work).toMatchObject({
      kind: 'start',
      run: {
        id: runId,
        number: 1,
        kind: 'delivery',
        spec_version: 1,
        task: { id: taskId, key: 'PAY-1', title: 'Retry webhooks', budget_usd: null },
        spec: { version: 1, criteria: [{ id: 'AC1' }] },
        project: {
          key: 'PAY',
          repo_path: '/repos/PAY',
          github_repo: 'owner/pay',
          base_branch: 'main',
          test_command: 'npm test',
        },
      },
    })
    expect(await state(taskId)).toBe('running')
    expect((await claim()).json()).toEqual({ work: null })
  })

  it('waits for work when asked to, and answers as soon as a run is queued', async () => {
    const pending = claim(5_000)
    await new Promise((done) => setTimeout(done, 200))
    // Seeded directly, so the test publishes what Task 10's queueDeliveryRun publishes.
    const { runId } = await seedQueuedRun(getTestDb())
    await publish(getTestDb(), { topic: 'run.queued', runId })
    expect((await pending).json().work.run.id).toBe(runId)
  })

  it('cancels a queued run whose task was cancelled, instead of handing it over', async () => {
    const { runId } = await seedQueuedRun(getTestDb(), { state: 'failed' })
    expect((await claim()).json()).toEqual({ work: null })
    const run = await getTestDb()
      .selectFrom('runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run.status).toBe('cancelled')
  })
})

describe('run tokens', () => {
  it('accept events for their own run', async () => {
    const { runId, token } = await claimed()
    expect((await send(token, [event(runId, 'message', {})])).json()).toEqual({ accepted: 1 })
  })

  it('refuse events for another run', async () => {
    const { token } = await claimed()
    const response = await send(token, [event(crypto.randomUUID(), 'message', {})])
    expect(response.statusCode).toBe(401)
  })

  it('expire twelve hours after issue', async () => {
    const { runId, token } = await claimed()
    now = new Date(now.getTime() + 12 * 3600_000 + 1)
    expect((await send(token, [event(runId, 'message', {})])).statusCode).toBe(401)
  })

  it('stop working five minutes after they are retired', async () => {
    const { runId, token } = await claimed()
    const retired = await app.inject({
      method: 'POST',
      url: '/api/runner/tokens/retire',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(retired.statusCode).toBe(204)
    now = new Date(now.getTime() + 4 * 60_000)
    expect((await send(token, [event(runId, 'message', {})])).statusCode).toBe(200)
    now = new Date(now.getTime() + 2 * 60_000)
    expect((await send(token, [event(runId, 'message', {})])).statusCode).toBe(401)
  })

  it('are issued only for a run that is running', async () => {
    const { runId } = await seedQueuedRun(getTestDb())
    const response = await app.inject({
      method: 'POST',
      url: `/api/runner/runs/${runId}/tokens`,
      headers: auth,
    })
    expect(response.statusCode).toBe(409)
  })
})

describe('POST /api/runner/events', () => {
  it('records a phase from its start and end events, with usage on the events', async () => {
    const { runId, token } = await claimed()
    const phaseId = crypto.randomUUID()
    await send(token, [
      event(
        runId,
        'phase_start',
        { name: 'plan', attempt: 1, session_id: crypto.randomUUID() },
        { phase_id: phaseId, agent: 'planner', model: 'm' },
      ),
      event(
        runId,
        'message',
        {},
        {
          phase_id: phaseId,
          agent: 'planner',
          model: 'm',
          usage: { input: 10, output: 20, cache_read: 30, cache_write: 40 },
        },
      ),
      event(
        runId,
        'phase_end',
        { status: 'succeeded', summary_md: 'Planned', reported_cost: { m: 0.01 } },
        { phase_id: phaseId },
      ),
    ])
    const phase = await getTestDb()
      .selectFrom('phases')
      .selectAll()
      .where('id', '=', phaseId)
      .executeTakeFirstOrThrow()
    expect(phase).toMatchObject({
      name: 'plan',
      attempt: 1,
      status: 'succeeded',
      summary_md: 'Planned',
      reported_cost: { m: 0.01 },
    })
    const run = await getTestDb()
      .selectFrom('runs')
      .select('current_phase')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run.current_phase).toBe('plan')
  })

  // Review Focus 3: a replay after the server was down counts each event once.
  it('ignores a replayed event', async () => {
    const { runId, token } = await claimed()
    const same = event(
      runId,
      'message',
      {},
      { model: 'm', usage: { input: 5, output: 0, cache_read: 0, cache_write: 0 } },
    )
    expect((await send(token, [same])).json()).toEqual({ accepted: 1 })
    expect((await send(token, [same])).json()).toEqual({ accepted: 0 })
    const rows = await getTestDb()
      .selectFrom('events')
      .select('input')
      .where('run_id', '=', runId)
      .execute()
    expect(rows).toEqual([{ input: 5 }])
  })

  it('moves the card to Review and records the pull request', async () => {
    const { runId, taskId, token } = await claimed()
    const announced = app.bus.next('run.event', 5_000)
    await send(token, [
      event(runId, 'run_end', {
        outcome: 'review',
        pr_number: 7,
        pr_url: 'https://github.com/owner/pay/pull/7',
        branch: 'board/PAY-1-r1',
      }),
    ])
    expect(await state(taskId)).toBe('review')
    const run = await getTestDb()
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run).toMatchObject({ status: 'succeeded', pr_number: 7, branch: 'board/PAY-1-r1' })
    const artifact = await getTestDb()
      .selectFrom('artifacts')
      .selectAll()
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(artifact).toMatchObject({ kind: 'pr', uri: 'https://github.com/owner/pay/pull/7' })
    expect(await announced).toEqual({ topic: 'run.event', runId, taskId })
  })

  it('moves the card to Failed with the reason', async () => {
    const { runId, taskId, token } = await claimed()
    await send(token, [
      event(runId, 'run_end', { outcome: 'failed', reason: 'verify failed three times' }),
    ])
    expect(await state(taskId)).toBe('failed')
    const run = await getTestDb()
      .selectFrom('runs')
      .select(['status', 'failure_reason'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run).toEqual({ status: 'failed', failure_reason: 'verify failed three times' })
  })

  it('accepts a failure report for a card the owner already cancelled', async () => {
    const { runId, taskId, token } = await claimed()
    await getTestDb()
      .updateTable('tasks')
      .set({ state: 'failed' })
      .where('id', '=', taskId)
      .execute()
    const response = await send(token, [
      event(runId, 'run_end', { outcome: 'cancelled', reason: 'cancelled by the owner' }),
    ])
    expect(response.statusCode).toBe(200)
    expect(await state(taskId)).toBe('failed')
  })

  it('refuses a malformed phase event without storing any of the batch', async () => {
    const { runId, token } = await claimed()
    const response = await send(token, [
      event(runId, 'message', {}),
      event(
        runId,
        'phase_start',
        { name: 'deploy', attempt: 1 },
        { phase_id: crypto.randomUUID(), agent: 'a', model: 'm' },
      ),
    ])
    expect(response.statusCode).toBe(400)
    const rows = await getTestDb()
      .selectFrom('events')
      .select('id')
      .where('run_id', '=', runId)
      .execute()
    expect(rows).toEqual([])
  })
})

describe('POST /api/runner/heartbeat', () => {
  it('records liveness and hands back the runs the owner cancelled', async () => {
    const { runId } = await claimed()
    await getTestDb()
      .updateTable('runs')
      .set({ cancel_requested: true })
      .where('id', '=', runId)
      .execute()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runner/heartbeat',
      headers: auth,
      payload: { runner_id: 'r1', run_ids: [runId] },
    })
    expect(response.json()).toEqual({ cancel: [runId] })
    const run = await getTestDb()
      .selectFrom('runs')
      .select('last_heartbeat_at')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(run.last_heartbeat_at).toEqual(now)
  })
})
```

- [ ] **Step 6: Run it to see it fail**

Run: `npm run --workspace server test -- tests/integration/runner.test.ts`
Expected: FAIL — 404s.

- [ ] **Step 7: Implement the service and routes**

`server/src/modules/runner/runner.service.ts`:

```ts
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { Bus } from '../../shared/bus.js'
import { publish } from '../../shared/bus.js'
import { ConflictError, UnauthorizedError } from '../../shared/errors.js'
import { hashToken, newToken } from '../../shared/tokens.js'
import type { SpecCriterion } from '../../shared/vocabulary.js'
import { moveTask } from '../tasks/task.moves.js'
import { effectOf, type Effect } from './event-effects.js'
import type { RunnerEvent } from './runner.schemas.js'

export interface Work {
  kind: 'start'
  run: {
    id: string
    number: number
    kind: 'spec' | 'delivery'
    spec_version: number
    task: {
      id: string
      key: string
      title: string
      description_md: string
      budget_usd: number | null
    }
    spec: { version: number; body_md: string; criteria: SpecCriterion[] }
    project: {
      key: string
      repo_path: string
      github_repo: string
      base_branch: string
      test_command: string
    }
  }
}

const TOKEN_LIFETIME_MS = 12 * 3600_000
const RETIRE_GRACE_MS = 5 * 60_000

export class RunnerService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly bus: Bus,
    private readonly clock: () => Date,
  ) {}

  async claim(runnerId: string, waitMs: number): Promise<Work | null> {
    const first = await this.tryClaim(runnerId)
    if (first !== null || waitMs === 0) return first
    await this.bus.next('run.queued', waitMs)
    return this.tryClaim(runnerId)
  }

  /** Skips — and cancels — queued runs whose task is no longer Ready. */
  private async tryClaim(runnerId: string): Promise<Work | null> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const outcome = await this.db.transaction().execute(async (trx) => {
        const run = await trx
          .selectFrom('runs')
          .select(['id', 'task_id'])
          .where('status', '=', 'queued')
          .orderBy('created_at')
          .limit(1)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst()
        if (run === undefined) return 'none' as const
        const task = await trx
          .selectFrom('tasks')
          .select('state')
          .where('id', '=', run.task_id)
          .forUpdate()
          .executeTakeFirstOrThrow()
        if (task.state !== 'ready') {
          await trx
            .updateTable('runs')
            .set({ status: 'cancelled', ended_at: this.clock() })
            .where('id', '=', run.id)
            .execute()
          return 'skipped' as const
        }
        await moveTask(trx, run.task_id, 'claim')
        const now = this.clock()
        await trx
          .updateTable('runs')
          .set({ status: 'running', runner_id: runnerId, started_at: now, last_heartbeat_at: now })
          .where('id', '=', run.id)
          .execute()
        return this.work(trx, run.id)
      })
      if (outcome === 'none') return null
      if (outcome !== 'skipped') return outcome
    }
    return null
  }

  private async work(trx: Transaction<Database>, runId: string): Promise<Work> {
    const row = await trx
      .selectFrom('runs')
      .innerJoin('tasks', 'tasks.id', 'runs.task_id')
      .innerJoin('projects', 'projects.id', 'tasks.project_id')
      .innerJoin('specs', (join) =>
        join
          .onRef('specs.task_id', '=', 'runs.task_id')
          .onRef('specs.version', '=', 'runs.spec_version'),
      )
      .select([
        'runs.id',
        'runs.kind',
        'runs.spec_version',
        'tasks.id as task_id',
        'tasks.number',
        'tasks.title',
        'tasks.description_md',
        'tasks.budget_usd',
        'projects.key',
        'projects.repo_path',
        'projects.github_repo',
        'projects.base_branch',
        'projects.test_command',
        'specs.body_md',
        'specs.criteria',
      ])
      .where('runs.id', '=', runId)
      .executeTakeFirstOrThrow()
    // Compared inside the database: a timestamp read into a Date loses its microseconds, and
    // the run would then not count itself.
    const { count } = await trx
      .selectFrom('runs')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('task_id', '=', row.task_id)
      .where('created_at', '<=', (eb) =>
        eb.selectFrom('runs as self').select('self.created_at').where('self.id', '=', runId),
      )
      .executeTakeFirstOrThrow()
    return {
      kind: 'start',
      run: {
        id: row.id,
        number: count,
        kind: row.kind,
        spec_version: row.spec_version,
        task: {
          id: row.task_id,
          key: `${row.key}-${row.number}`,
          title: row.title,
          description_md: row.description_md,
          budget_usd: row.budget_usd === null ? null : Number(row.budget_usd),
        },
        spec: { version: row.spec_version, body_md: row.body_md, criteria: row.criteria ?? [] },
        project: {
          key: row.key,
          repo_path: row.repo_path,
          github_repo: row.github_repo,
          base_branch: row.base_branch,
          test_command: row.test_command,
        },
      },
    }
  }

  async heartbeat(runnerId: string, runIds: string[]): Promise<{ cancel: string[] }> {
    if (runIds.length === 0) return { cancel: [] }
    await this.db
      .updateTable('runs')
      .set({ last_heartbeat_at: this.clock() })
      .where('id', 'in', runIds)
      .where('runner_id', '=', runnerId)
      .execute()
    const rows = await this.db
      .selectFrom('runs')
      .select('id')
      .where('id', 'in', runIds)
      .where('cancel_requested', '=', true)
      .execute()
    return { cancel: rows.map((row) => row.id) }
  }

  async issueToken(runId: string): Promise<{ token: string }> {
    const run = await this.db
      .selectFrom('runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirst()
    if (run?.status !== 'running')
      throw new ConflictError('Tokens are issued only for a running run')
    const { token, hash } = newToken()
    await this.db
      .insertInto('run_tokens')
      .values({
        run_id: runId,
        token_hash: hash,
        expires_at: new Date(this.clock().getTime() + TOKEN_LIFETIME_MS),
      })
      .execute()
    return { token }
  }

  async retire(token: string): Promise<void> {
    const until = new Date(this.clock().getTime() + RETIRE_GRACE_MS)
    await this.db
      .updateTable('run_tokens')
      .set((eb) => ({ expires_at: eb.fn('least', [eb.ref('expires_at'), eb.val(until)]) }))
      .where('token_hash', '=', hashToken(token))
      .execute()
  }

  /** One transaction: a malformed event refuses the whole batch, so a replay is all or nothing. */
  async ingest(
    context: { runId: string; taskId: string },
    events: RunnerEvent[],
  ): Promise<{ accepted: number }> {
    if (events.some((event) => event.run_id !== context.runId)) throw new UnauthorizedError()
    const effects = events.map((event) => effectOf(event))
    return this.db.transaction().execute(async (trx) => {
      let accepted = 0
      for (const [index, event] of events.entries()) {
        const inserted = await trx
          .insertInto('events')
          .values({
            id: event.id,
            run_id: event.run_id,
            phase_id: event.phase_id,
            ts: event.ts,
            type: event.type,
            agent: event.agent,
            model: event.model,
            tool: event.tool,
            target: event.target,
            status: event.status,
            duration_ms: event.duration_ms,
            input: event.usage.input,
            output: event.usage.output,
            cache_read: event.usage.cache_read,
            cache_write: event.usage.cache_write,
            payload: JSON.stringify(event.payload),
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .returning('id')
          .executeTakeFirst()
        if (inserted === undefined) continue
        accepted += 1
        const effect = effects[index]
        if (effect !== undefined) await this.apply(trx, context, effect)
      }
      if (accepted > 0)
        await publish(trx, { topic: 'run.event', runId: context.runId, taskId: context.taskId })
      return { accepted }
    })
  }

  private async apply(
    trx: Transaction<Database>,
    context: { runId: string; taskId: string },
    effect: Effect,
  ): Promise<void> {
    switch (effect.kind) {
      case 'phase_start':
        await trx
          .insertInto('phases')
          .values({
            id: effect.phaseId,
            run_id: context.runId,
            name: effect.name,
            attempt: effect.attempt,
            agent: effect.agent,
            model: effect.model,
            status: 'running',
            session_id: effect.sessionId,
            started_at: effect.at,
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .execute()
        await trx
          .updateTable('runs')
          .set((eb) => ({
            current_phase: effect.name,
            fix_loops:
              effect.name === 'build'
                ? eb.fn('greatest', [eb.ref('fix_loops'), eb.val(effect.attempt - 1)])
                : eb.ref('fix_loops'),
          }))
          .where('id', '=', context.runId)
          .execute()
        return
      case 'phase_end':
        await trx
          .updateTable('phases')
          .set((eb) => ({
            status: effect.status,
            summary_md: effect.summary,
            reported_cost:
              effect.reportedCost === null ? null : JSON.stringify(effect.reportedCost),
            session_id: eb.fn.coalesce(eb.val(effect.sessionId), eb.ref('session_id')),
            ended_at: effect.at,
          }))
          .where('id', '=', effect.phaseId)
          .where('run_id', '=', context.runId)
          .execute()
        return
      case 'run_end': {
        const status = effect.outcome === 'review' ? 'succeeded' : effect.outcome
        await trx
          .updateTable('runs')
          .set({
            status,
            ended_at: effect.at,
            failure_reason: effect.reason,
            pr_number: effect.prNumber,
            pr_url: effect.prUrl,
            branch: effect.branch,
            worktree_path: effect.worktreePath,
          })
          .where('id', '=', context.runId)
          .execute()
        if (effect.prUrl !== null) {
          await trx
            .insertInto('artifacts')
            .values({
              run_id: context.runId,
              phase_id: null,
              kind: 'pr',
              body_md: `[#${effect.prNumber}](${effect.prUrl})`,
              uri: effect.prUrl,
              data: null,
            })
            .execute()
        }
        const task = await trx
          .selectFrom('tasks')
          .select('state')
          .where('id', '=', context.taskId)
          .executeTakeFirstOrThrow()
        // A run the owner cancelled has already moved its card; its own report moves nothing.
        if (task.state !== 'running') return
        await moveTask(trx, context.taskId, effect.outcome === 'review' ? 'finish_review' : 'fail')
        return
      }
    }
  }
}
```

`server/src/modules/runner/runner.routes.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { UnauthorizedError } from '../../shared/errors.js'
import { bearer, resolveRunToken, sameSecret } from '../../shared/tokens.js'
import { ClaimBody, EventsBody, HeartbeatBody, RunParams } from './runner.schemas.js'
import { RunnerService } from './runner.service.js'

declare module 'fastify' {
  interface FastifyRequest {
    runContext: { runId: string; taskId: string } | null
  }
}

export function registerRunner(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new RunnerService(app.db, app.bus, app.clock)
  app.decorateRequest('runContext', null)

  const runnerKey = async (request: FastifyRequest) => {
    const token = bearer(request.headers.authorization)
    if (token === undefined || !sameSecret(token, app.config.runnerKey))
      throw new UnauthorizedError()
  }
  const runToken = async (request: FastifyRequest) => {
    request.runContext = await resolveRunToken(app.db, request.headers.authorization, app.clock())
  }
  const context = (request: FastifyRequest) => {
    if (request.runContext === null) throw new UnauthorizedError()
    return request.runContext
  }

  app.post(
    '/api/runner/claim',
    { preHandler: runnerKey, schema: { body: ClaimBody } },
    async (request) => ({
      work: await service.claim(
        request.body.runner_id,
        request.body.wait_ms ?? app.config.claimWaitMs,
      ),
    }),
  )

  app.post(
    '/api/runner/heartbeat',
    { preHandler: runnerKey, schema: { body: HeartbeatBody } },
    async (request) => service.heartbeat(request.body.runner_id, request.body.run_ids),
  )

  app.post(
    '/api/runner/runs/:id/tokens',
    { preHandler: runnerKey, schema: { params: RunParams } },
    async (request) => service.issueToken(request.params.id),
  )

  app.post(
    '/api/runner/events',
    { preHandler: runToken, schema: { body: EventsBody } },
    async (request) => service.ingest(context(request), request.body.events),
  )

  app.post('/api/runner/tokens/retire', { preHandler: runToken }, async (request, reply) => {
    await service.retire(bearer(request.headers.authorization) ?? '')
    reply.status(204)
  })
}
```

Register in `server/src/app.ts` after `registerSpecs(app)`: `registerRunner(app)`.

- [ ] **Step 8: Run it to see it pass**

Run: `npm run --workspace server test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server
git commit -m "feat(server): hand runs to the runner and let its events move the board"
```

---

### Task 12: The board MCP server

**Files:**

- Create: `server/src/modules/mcp/plan-check.ts`, `server/src/modules/mcp/board-tools.ts`,
  `server/src/modules/mcp/mcp.routes.ts`
- Modify: `server/package.json` (dependencies), `server/src/app.ts`
- Test: `server/tests/unit/plan-check.test.ts`, `server/tests/integration/mcp.test.ts`

**Interfaces:**

- Consumes: `resolveRunToken`, `parseSpec`, `publish`, `seedQueuedRun`.
- Produces:
  - `PlanInput { summary: string; confidence: 'high' | 'medium' | 'low'; steps: { title: string;
requirements: string[]; files: string[]; estimate_usd?: number }[]; checks: { criterion: string; how: string }[] }`;
    `ReportInput { summary: string; criteria: { id: string; status: 'pass' | 'fail'; evidence: string }[] }`;
    `checkPlan(plan, spec: { requirements: string[]; criteria: SpecCriterion[] }): PlanFinding[]`;
    `checkReport(report, criteria: SpecCriterion[]): ReportFinding[]`;
    `renderPlan(plan): string`; `renderReport(report): string`; `planFiles(plan): string[]`.
  - MCP server `board` at `POST /mcp` (stateless streamable HTTP, `Authorization: Bearer <run token>`)
    with tools `get_task`, `get_spec`, `save_plan`, `save_report`, `log_step`. The artifacts are
    attached to the run's latest running phase; `data` holds the input as given.

- [ ] **Step 1: Dependencies**

```bash
npm install --workspace server @modelcontextprotocol/sdk@^1.32.1 zod@^4.1.0
```

- [ ] **Step 2: Write the failing unit test**

`server/tests/unit/plan-check.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  checkPlan,
  checkReport,
  planFiles,
  renderPlan,
  renderReport,
  type PlanInput,
} from '../../src/modules/mcp/plan-check.js'

const SPEC = {
  requirements: ['R1', 'R2'],
  criteria: [
    { id: 'AC1', requirements: ['R1'], text: 'a' },
    { id: 'AC2', requirements: ['R2'], text: 'b' },
  ],
}
const PLAN: PlanInput = {
  summary: 'Two steps',
  confidence: 'high',
  steps: [
    {
      title: 'Backoff',
      requirements: ['R1'],
      files: ['src/retry.ts', 'src/retry.test.ts'],
      estimate_usd: 0.4,
    },
    { title: 'Dead letters', requirements: ['R2'], files: ['src/retry.ts'] },
  ],
  checks: [
    { criterion: 'AC1', how: 'unit test of the delays' },
    { criterion: 'AC2', how: 'unit test of the fourth failure' },
  ],
}

describe('checkPlan', () => {
  it('accepts a plan that maps every step and every criterion', () => {
    expect(checkPlan(PLAN, SPEC)).toEqual([])
  })

  it.each([
    [
      'a step naming an unknown requirement',
      { ...PLAN, steps: [{ ...PLAN.steps[0]!, requirements: ['R9'] }, PLAN.steps[1]!] },
      [{ code: 'unknown_requirement', step: 1, id: 'R9' }],
    ],
    [
      'a criterion without a check',
      { ...PLAN, checks: [PLAN.checks[0]!] },
      [{ code: 'criterion_without_check', id: 'AC2' }],
    ],
    [
      'a check for an unknown criterion',
      { ...PLAN, checks: [...PLAN.checks, { criterion: 'AC7', how: 'x' }] },
      [{ code: 'unknown_criterion', id: 'AC7' }],
    ],
  ])('reports %s', (_name, plan, findings) => {
    expect(checkPlan(plan, SPEC)).toEqual(findings)
  })

  it('lists the files the plan touches once each, sorted', () => {
    expect(planFiles(PLAN)).toEqual(['src/retry.test.ts', 'src/retry.ts'])
  })

  it('renders the plan with its steps and checks', () => {
    const text = renderPlan(PLAN)
    expect(text).toContain('1. **Backoff** (R1) — `src/retry.ts`, `src/retry.test.ts` — est. $0.40')
    expect(text).toContain('| AC2 | unit test of the fourth failure |')
  })
})

describe('checkReport', () => {
  const REPORT = {
    summary: 'One failed',
    criteria: [
      { id: 'AC1', status: 'pass' as const, evidence: 'test passes' },
      { id: 'AC2', status: 'fail' as const, evidence: 'no dead letter' },
    ],
  }

  it('accepts a verdict on every criterion', () => {
    expect(checkReport(REPORT, SPEC.criteria)).toEqual([])
  })

  it.each([
    [
      'a missing criterion',
      { ...REPORT, criteria: [REPORT.criteria[0]!] },
      [{ code: 'missing_criterion', id: 'AC2' }],
    ],
    [
      'an unknown criterion',
      {
        ...REPORT,
        criteria: [...REPORT.criteria, { id: 'AC9', status: 'pass' as const, evidence: 'x' }],
      },
      [{ code: 'unknown_criterion', id: 'AC9' }],
    ],
    [
      'a criterion twice',
      { ...REPORT, criteria: [...REPORT.criteria, REPORT.criteria[0]!] },
      [{ code: 'duplicate_criterion', id: 'AC1' }],
    ],
  ])('reports %s', (_name, report, findings) => {
    expect(checkReport(report, SPEC.criteria)).toEqual(findings)
  })

  it('renders a table with a mark per criterion', () => {
    expect(renderReport(REPORT)).toContain('| AC2 | ✘ fail | no dead letter |')
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm run --workspace server test -- tests/unit/plan-check.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the checks**

`server/src/modules/mcp/plan-check.ts`:

```ts
import type { SpecCriterion } from '../../shared/vocabulary.js'

export interface PlanInput {
  summary: string
  confidence: 'high' | 'medium' | 'low'
  steps: { title: string; requirements: string[]; files: string[]; estimate_usd?: number }[]
  checks: { criterion: string; how: string }[]
}

export interface ReportInput {
  summary: string
  criteria: { id: string; status: 'pass' | 'fail'; evidence: string }[]
}

export interface PlanFinding {
  code: 'unknown_requirement' | 'criterion_without_check' | 'unknown_criterion'
  step?: number
  id: string
}

export interface ReportFinding {
  code: 'missing_criterion' | 'unknown_criterion' | 'duplicate_criterion'
  id: string
}

export function checkPlan(
  plan: PlanInput,
  spec: { requirements: string[]; criteria: SpecCriterion[] },
): PlanFinding[] {
  const findings: PlanFinding[] = []
  const requirements = new Set(spec.requirements)
  plan.steps.forEach((step, index) => {
    for (const id of step.requirements) {
      if (!requirements.has(id)) findings.push({ code: 'unknown_requirement', step: index + 1, id })
    }
  })
  const criteria = new Set(spec.criteria.map((c) => c.id))
  const checked = new Set(plan.checks.map((c) => c.criterion))
  for (const id of criteria)
    if (!checked.has(id)) findings.push({ code: 'criterion_without_check', id })
  for (const id of checked) if (!criteria.has(id)) findings.push({ code: 'unknown_criterion', id })
  return findings
}

export function checkReport(report: ReportInput, criteria: SpecCriterion[]): ReportFinding[] {
  const findings: ReportFinding[] = []
  const known = new Set(criteria.map((c) => c.id))
  const seen = new Set<string>()
  for (const verdict of report.criteria) {
    if (!known.has(verdict.id)) findings.push({ code: 'unknown_criterion', id: verdict.id })
    else if (seen.has(verdict.id)) findings.push({ code: 'duplicate_criterion', id: verdict.id })
    seen.add(verdict.id)
  }
  for (const id of known) if (!seen.has(id)) findings.push({ code: 'missing_criterion', id })
  return findings
}

export function planFiles(plan: PlanInput): string[] {
  return [...new Set(plan.steps.flatMap((step) => step.files))].sort()
}

export function renderPlan(plan: PlanInput): string {
  const steps = plan.steps.map((step, index) => {
    const files = step.files.map((f) => `\`${f}\``).join(', ')
    const estimate =
      step.estimate_usd === undefined ? '' : ` — est. $${step.estimate_usd.toFixed(2)}`
    return `${index + 1}. **${step.title}** (${step.requirements.join(', ')}) — ${files}${estimate}`
  })
  const checks = plan.checks.map((check) => `| ${check.criterion} | ${check.how} |`)
  return [
    plan.summary,
    '',
    `Confidence: ${plan.confidence}`,
    '',
    ...steps,
    '',
    '| Criterion | Check |',
    '| --- | --- |',
    ...checks,
  ].join('\n')
}

export function renderReport(report: ReportInput): string {
  const rows = report.criteria.map(
    (c) =>
      `| ${c.id} | ${c.status === 'pass' ? '✔ pass' : '✘ fail'} | ${c.evidence.replaceAll('|', '\\|').replaceAll('\n', ' ')} |`,
  )
  return [
    report.summary,
    '',
    '| Criterion | Verdict | Evidence |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n')
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `npm run --workspace server test -- tests/unit/plan-check.test.ts && grep -l "db/" server/src/modules/mcp/plan-check.ts`
Expected: PASS; `grep` prints nothing.

- [ ] **Step 6: Write the failing integration test**

`server/tests/integration/mcp.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb, TEST_RUNNER_KEY } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'

let app: FastifyInstance
let base: string

beforeAll(async () => {
  app = await buildTestApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const auth = { authorization: `Bearer ${TEST_RUNNER_KEY}` }

/** A claimed run with a running Plan phase, and an MCP client holding its token. */
async function session() {
  const seeded = await seedQueuedRun(getTestDb())
  await app.inject({
    method: 'POST',
    url: '/api/runner/claim',
    headers: auth,
    payload: { runner_id: 'r1' },
  })
  const token = (
    await app.inject({
      method: 'POST',
      url: `/api/runner/runs/${seeded.runId}/tokens`,
      headers: auth,
    })
  ).json().token as string
  const phaseId = crypto.randomUUID()
  await getTestDb()
    .insertInto('phases')
    .values({
      id: phaseId,
      run_id: seeded.runId,
      name: 'plan',
      attempt: 1,
      agent: 'planner',
      model: 'm',
      status: 'running',
      started_at: new Date(),
    })
    .execute()
  const client = new Client({ name: 'test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  // As in mcp.routes.ts: the SDK's class and interface disagree under exactOptionalPropertyTypes.
  await client.connect(transport as Transport)
  return { ...seeded, phaseId, client }
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n')

const PLAN = {
  summary: 'One step',
  confidence: 'high',
  steps: [{ title: 'Backoff', requirements: ['R1'], files: ['src/retry.ts'] }],
  checks: [{ criterion: 'AC1', how: 'unit test' }],
}

describe('the board MCP server', () => {
  it('refuses a request without a run token', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(response.status).toBe(401)
  })

  it('offers the five tools', async () => {
    const { client } = await session()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_spec',
      'get_task',
      'log_step',
      'save_plan',
      'save_report',
    ])
  })

  it('reads the task and its frozen spec', async () => {
    const { client } = await session()
    expect(
      JSON.parse(text(await client.callTool({ name: 'get_task', arguments: {} }))),
    ).toMatchObject({ key: 'PAY-1', title: 'Retry webhooks' })
    expect(
      JSON.parse(text(await client.callTool({ name: 'get_spec', arguments: {} }))),
    ).toMatchObject({ version: 1, requirements: ['R1'], criteria: [{ id: 'AC1' }] })
  })

  it('saves a plan that checks out, on the running phase', async () => {
    const { client, runId, phaseId } = await session()
    const result = await client.callTool({ name: 'save_plan', arguments: PLAN })
    expect(result.isError).toBeFalsy()
    const artifact = await getTestDb()
      .selectFrom('artifacts')
      .selectAll()
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(artifact).toMatchObject({ kind: 'plan', phase_id: phaseId, data: PLAN })
  })

  it('refuses a plan that leaves a criterion unchecked, saying which', async () => {
    const { client, runId } = await session()
    const result = await client.callTool({ name: 'save_plan', arguments: { ...PLAN, checks: [] } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('criterion_without_check AC1')
    expect(
      await getTestDb().selectFrom('artifacts').select('id').where('run_id', '=', runId).execute(),
    ).toEqual([])
  })

  it('saves a verify report with a verdict on every criterion', async () => {
    const { client, runId } = await session()
    const report = {
      summary: 'Passed',
      criteria: [{ id: 'AC1', status: 'pass', evidence: 'test passes' }],
    }
    expect((await client.callTool({ name: 'save_report', arguments: report })).isError).toBeFalsy()
    const artifact = await getTestDb()
      .selectFrom('artifacts')
      .selectAll()
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(artifact).toMatchObject({ kind: 'verify_report', data: report })
  })

  it('logs a declared step as a message event of the phase agent', async () => {
    const { client, runId, phaseId } = await session()
    await client.callTool({
      name: 'log_step',
      arguments: { summary: 'Read the retry module', confidence: 'medium' },
    })
    const event = await getTestDb()
      .selectFrom('events')
      .selectAll()
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow()
    expect(event).toMatchObject({
      type: 'message',
      phase_id: phaseId,
      agent: 'planner',
      payload: { declared: true, summary: 'Read the retry module', confidence: 'medium' },
    })
  })
})
```

- [ ] **Step 7: Run it to see it fail**

Run: `npm run --workspace server test -- tests/integration/mcp.test.ts`
Expected: FAIL — `/mcp` answers 404.

- [ ] **Step 8: Implement the tools and the route**

`server/src/modules/mcp/board-tools.ts`:

```ts
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Database } from '../../db/schema.js'
import { publish } from '../../shared/bus.js'
import { parseSpec } from '../specs/spec-parser.js'
import {
  checkPlan,
  checkReport,
  renderPlan,
  renderReport,
  type PlanInput,
  type ReportInput,
} from './plan-check.js'

export interface ToolContext {
  db: Kysely<Database>
  runId: string
  taskId: string
  clock: () => Date
}

const reply = (text: string, isError = false) => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError } : {}),
})
const json = (value: unknown) => reply(JSON.stringify(value, null, 2))

async function runningPhase(ctx: ToolContext) {
  return ctx.db
    .selectFrom('phases')
    .select(['id', 'agent', 'name'])
    .where('run_id', '=', ctx.runId)
    .where('status', '=', 'running')
    .orderBy('started_at', 'desc')
    .executeTakeFirst()
}

async function frozenSpec(ctx: ToolContext) {
  const row = await ctx.db
    .selectFrom('runs')
    .innerJoin('specs', (join) =>
      join
        .onRef('specs.task_id', '=', 'runs.task_id')
        .onRef('specs.version', '=', 'runs.spec_version'),
    )
    .select(['specs.version', 'specs.body_md', 'specs.criteria'])
    .where('runs.id', '=', ctx.runId)
    .executeTakeFirstOrThrow()
  return {
    version: row.version,
    body_md: row.body_md,
    requirements: parseSpec(row.body_md).requirements.map((r) => r.id),
    criteria: row.criteria ?? [],
  }
}

async function attach(
  ctx: ToolContext,
  kind: 'plan' | 'verify_report',
  body: string,
  data: unknown,
) {
  const phase = await runningPhase(ctx)
  if (phase === undefined) return reply('No phase of this run is running; nothing was saved.', true)
  await ctx.db
    .insertInto('artifacts')
    .values({
      run_id: ctx.runId,
      phase_id: phase.id,
      kind,
      body_md: body,
      uri: null,
      data: JSON.stringify(data),
    })
    .execute()
  await publish(ctx.db, { topic: 'run.event', runId: ctx.runId, taskId: ctx.taskId })
  return undefined
}

const findingsText = (title: string, findings: { code: string; id: string; step?: number }[]) =>
  [
    title,
    ...findings.map((f) => `- ${f.code} ${f.id}${f.step === undefined ? '' : ` (step ${f.step})`}`),
  ].join('\n')

export function registerBoardTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_task',
    { description: 'Read the task this run carries out.' },
    async () => {
      const row = await ctx.db
        .selectFrom('tasks')
        .innerJoin('projects', 'projects.id', 'tasks.project_id')
        .select(['tasks.number', 'tasks.title', 'tasks.description_md', 'projects.key'])
        .where('tasks.id', '=', ctx.taskId)
        .executeTakeFirstOrThrow()
      const phase = await runningPhase(ctx)
      return json({
        key: `${row.key}-${row.number}`,
        title: row.title,
        description_md: row.description_md,
        run_id: ctx.runId,
        phase: phase?.name ?? null,
      })
    },
  )

  server.registerTool(
    'get_spec',
    { description: 'Read the approved, frozen spec this run must satisfy.' },
    async () => json(await frozenSpec(ctx)),
  )

  server.registerTool(
    'save_plan',
    {
      description:
        'Save the plan for this run. Every step names the requirements it serves and the files it touches; every acceptance criterion gets a check. Refused, with the reasons, when it does not map onto the spec.',
      inputSchema: {
        summary: z.string().min(1).max(4000),
        confidence: z.enum(['high', 'medium', 'low']),
        steps: z
          .array(
            z.object({
              title: z.string().min(1),
              requirements: z.array(z.string()).min(1),
              files: z.array(z.string()),
              estimate_usd: z.number().nonnegative().optional(),
            }),
          )
          .min(1)
          .max(50),
        // No minimum: an empty list reaches checkPlan, which names each criterion left unchecked.
        checks: z.array(z.object({ criterion: z.string(), how: z.string().min(1) })),
      },
    },
    async (input) => {
      const plan = input as PlanInput
      const findings = checkPlan(plan, await frozenSpec(ctx))
      if (findings.length > 0) return reply(findingsText('The plan was not saved:', findings), true)
      return (await attach(ctx, 'plan', renderPlan(plan), plan)) ?? reply('Plan saved.')
    },
  )

  server.registerTool(
    'save_report',
    {
      description:
        'Save the verify report: a pass or fail verdict, with evidence, on every acceptance criterion.',
      inputSchema: {
        summary: z.string().min(1).max(4000),
        criteria: z
          .array(
            z.object({
              id: z.string(),
              status: z.enum(['pass', 'fail']),
              evidence: z.string().min(1),
            }),
          )
          .min(1),
      },
    },
    async (input) => {
      const report = input as ReportInput
      const findings = checkReport(report, (await frozenSpec(ctx)).criteria)
      if (findings.length > 0)
        return reply(findingsText('The report was not saved:', findings), true)
      return (
        (await attach(ctx, 'verify_report', renderReport(report), report)) ?? reply('Report saved.')
      )
    },
  )

  server.registerTool(
    'log_step',
    {
      description: 'Record a step you took, in one line, with your confidence in it.',
      inputSchema: {
        summary: z.string().min(1).max(2000),
        confidence: z.enum(['high', 'medium', 'low']).optional(),
      },
    },
    async (input) => {
      const phase = await runningPhase(ctx)
      await ctx.db
        .insertInto('events')
        .values({
          id: crypto.randomUUID(),
          run_id: ctx.runId,
          phase_id: phase?.id ?? null,
          ts: ctx.clock(),
          type: 'message',
          agent: phase?.agent ?? null,
          model: null,
          tool: null,
          target: null,
          status: null,
          duration_ms: null,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          payload: JSON.stringify({
            declared: true,
            summary: input.summary,
            ...(input.confidence ? { confidence: input.confidence } : {}),
          }),
        })
        .execute()
      await publish(ctx.db, { topic: 'run.event', runId: ctx.runId, taskId: ctx.taskId })
      return reply('Logged.')
    },
  )
}
```

`server/src/modules/mcp/mcp.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { resolveRunToken } from '../../shared/tokens.js'
import { registerBoardTools } from './board-tools.js'

/**
 * Stateless: a server and a transport per request, bound to the run the token names. Nothing
 * survives between calls, so a restarted server serves a running agent without it noticing.
 */
export function registerMcp(app: FastifyInstance): void {
  app.post('/mcp', async (request, reply) => {
    const context = await resolveRunToken(app.db, request.headers.authorization, app.clock())
    const server = new McpServer({ name: 'board', version: '1.0.0' })
    registerBoardTools(server, { db: app.db, clock: app.clock, ...context })
    // No sessionIdGenerator: the SDK reads its absence as stateless.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    reply.hijack()
    reply.raw.on('close', () => {
      void transport.close()
      void server.close()
    })
    // The SDK's transport classes declare their optional handlers without `| undefined`, which
    // `exactOptionalPropertyTypes` will not match to its own Transport interface.
    await server.connect(transport as Transport)
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })

  // A stateless server keeps no stream to resume and no session to end.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      handler: async (_request, reply) =>
        reply
          .status(405)
          .send({ error: 'bad_request', message: 'This MCP server is stateless; use POST' }),
    })
  }
}
```

Register in `server/src/app.ts` after `registerRunner(app)`: `registerMcp(app)`.

- [ ] **Step 9: Run it to see it pass**

Run: `npm run --workspace server test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server package-lock.json
git commit -m "feat(mcp): serve the board's tools to the agents of a run"
```

---

### Task 13: Reading a run — the timeline, the costs, and the board's cards

**Files:**

- Create: `server/src/modules/runs/run.repository.ts`, `run.service.ts`, `run.routes.ts`,
  `server/src/modules/costs/cost.service.ts`, `cost.routes.ts`
- Modify: `server/src/modules/tasks/task.repository.ts` (`TaskCard`), `task.service.ts`
  (`board`), `server/src/app.ts`
- Test: `server/tests/integration/runs-read.test.ts`

**Interfaces:**

- Consumes: `summarizeCosts`, `priceAt`, `costOf`.
- Produces:
  - `RunView { id; number; kind; status; spec_version; current_phase; branch; pr_number; pr_url;
failure_reason; fix_loops; created_at; started_at; ended_at; phases: PhaseView[]; artifacts: ArtifactView[] }`,
    `PhaseView { id; name; attempt; agent; model; status; summary_md; started_at; ended_at }`,
    `ArtifactView { id; kind; phase_id; body_md; uri; data }`,
    `EventView { id; phase_id; ts; type; agent; model; tool; target; status; duration_ms;
usage: { input; output; cache_read; cache_write }; payload }`.
  - `GET /api/tasks/:id/runs` → `RunView[]` newest first; `GET /api/runs/:id` → `RunView`;
    `GET /api/runs/:id/events?after=<cursor>&limit=<1..1000>` → `{ events: EventView[]; next: string | null }`;
    `GET /api/tasks/:id/costs` → `CostSummary` (Task 6's shape).
  - `TaskCard` gains `{ phase: PhaseName | null; attempt: number | null; models: string[];
cost_usd: number; cost_complete: boolean; pr_url: string | null }`.
  - `loadPrices(db): Promise<PriceRow[]>`.

- [ ] **Step 1: Write the failing test**

`server/tests/integration/runs-read.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'

let app: FastifyInstance
let ids: { taskId: string; runId: string }
const PLAN_PHASE = crypto.randomUUID()
const BUILD_PHASE = crypto.randomUUID()
const TS = new Date('2026-10-11T10:00:00Z')

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(async () => {
  await resetDb()
  ids = await seedQueuedRun(getTestDb())
  const db = getTestDb()
  await db
    .updateTable('runs')
    .set({ status: 'running', current_phase: 'build' })
    .where('id', '=', ids.runId)
    .execute()
  await db.updateTable('tasks').set({ state: 'running' }).where('id', '=', ids.taskId).execute()
  await db
    .insertInto('prices')
    .values({
      model: 'm',
      effective_from: '2026-01-01',
      input: 1,
      output: 5,
      cache_read: 0.1,
      cache_write: 2,
    })
    .execute()
  await db
    .insertInto('phases')
    .values([
      {
        id: PLAN_PHASE,
        run_id: ids.runId,
        name: 'plan',
        attempt: 1,
        agent: 'planner',
        model: 'm',
        status: 'succeeded',
        started_at: TS,
        reported_cost: JSON.stringify({ m: 1 }),
      },
      {
        id: BUILD_PHASE,
        run_id: ids.runId,
        name: 'build',
        attempt: 1,
        agent: 'builder',
        model: 'm',
        status: 'running',
        started_at: new Date(TS.getTime() + 60_000),
      },
    ])
    .execute()
  const usage = (input: number) => ({ input, output: 0, cache_read: 0, cache_write: 0 })
  const rows = [
    { phase: PLAN_PHASE, agent: 'planner', model: 'm', ...usage(1_000_000), at: 0, tool: null },
    { phase: BUILD_PHASE, agent: 'builder', model: 'm', ...usage(500_000), at: 1, tool: null },
    { phase: BUILD_PHASE, agent: 'builder', model: null, ...usage(0), at: 2, tool: 'Edit' },
  ]
  await db
    .insertInto('events')
    .values(
      rows.map((row) => ({
        id: crypto.randomUUID(),
        run_id: ids.runId,
        phase_id: row.phase,
        ts: new Date(TS.getTime() + row.at * 1000),
        type: row.model === null ? 'tool_call' : 'message',
        agent: row.agent,
        model: row.model,
        tool: row.tool,
        target: null,
        status: null,
        duration_ms: null,
        input: row.input,
        output: row.output,
        cache_read: row.cache_read,
        cache_write: row.cache_write,
        payload: '{}',
      })),
    )
    .execute()
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('reading a run', () => {
  it('lists the task’s runs with their phases', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${ids.taskId}/runs` })
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: ids.runId,
        number: 1,
        status: 'running',
        phases: [
          expect.objectContaining({ id: PLAN_PHASE, name: 'plan' }),
          expect.objectContaining({ id: BUILD_PHASE, name: 'build' }),
        ],
      }),
    ])
  })

  it('pages through events in time order with a cursor', async () => {
    const first = (
      await app.inject({ method: 'GET', url: `/api/runs/${ids.runId}/events?limit=2` })
    ).json()
    expect(first.events).toHaveLength(2)
    expect(first.next).toEqual(expect.any(String))
    const second = (
      await app.inject({
        method: 'GET',
        url: `/api/runs/${ids.runId}/events?limit=2&after=${encodeURIComponent(first.next)}`,
      })
    ).json()
    expect(second.events.map((e: { tool: string | null }) => e.tool)).toEqual(['Edit'])
    expect(second.next).toBeNull()
  })

  it('summarises the task’s costs', async () => {
    const summary = (
      await app.inject({ method: 'GET', url: `/api/tasks/${ids.taskId}/costs` })
    ).json()
    expect(summary.totals.usd).toBeCloseTo(1.5, 10)
    expect(summary.byPhase[0]).toMatchObject({
      phaseId: PLAN_PHASE,
      usd: 1,
      reportedUsd: 1,
      flagged: false,
    })
    expect(summary.missingPrices).toEqual([])
  })

  it('puts the phase, the models and the cost on the board card', async () => {
    const board = (await app.inject({ method: 'GET', url: '/api/projects/PAY/tasks' })).json()
    expect(board.tasks[0]).toMatchObject({
      state: 'running',
      phase: 'build',
      attempt: 1,
      models: ['m'],
      cost_complete: true,
      pr_url: null,
    })
    expect(board.tasks[0].cost_usd).toBeCloseTo(1.5, 10)
  })

  it('says a card’s cost is incomplete while a model has no price', async () => {
    await getTestDb().deleteFrom('prices').execute()
    const board = (await app.inject({ method: 'GET', url: '/api/projects/PAY/tasks' })).json()
    expect(board.tasks[0]).toMatchObject({ cost_usd: 0, cost_complete: false })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run --workspace server test -- tests/integration/runs-read.test.ts`
Expected: FAIL — 404s, and the card has no `phase`.

- [ ] **Step 3: Implement**

`server/src/modules/runs/run.repository.ts`:

```ts
import { sql, type Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

export interface PhaseView {
  id: string
  name: string
  attempt: number
  agent: string
  model: string
  status: string
  summary_md: string | null
  started_at: Date
  ended_at: Date | null
}
export interface ArtifactView {
  id: string
  kind: string
  phase_id: string | null
  body_md: string
  uri: string | null
  data: unknown
}
export interface RunView {
  id: string
  number: number
  kind: string
  status: string
  spec_version: number
  current_phase: string | null
  branch: string | null
  pr_number: number | null
  pr_url: string | null
  failure_reason: string | null
  fix_loops: number
  created_at: Date
  started_at: Date | null
  ended_at: Date | null
  phases: PhaseView[]
  artifacts: ArtifactView[]
}
export interface EventView {
  id: string
  phase_id: string | null
  ts: Date
  type: string
  agent: string | null
  model: string | null
  tool: string | null
  target: string | null
  status: string | null
  duration_ms: number | null
  usage: { input: number; output: number; cache_read: number; cache_write: number }
  payload: Record<string, unknown>
}

export class RunRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async forTask(taskId: string): Promise<RunView[]> {
    const runs = await this.db
      .selectFrom('runs')
      .select([
        'id',
        'kind',
        'status',
        'spec_version',
        'current_phase',
        'branch',
        'pr_number',
        'pr_url',
        'failure_reason',
        'fix_loops',
        'created_at',
        'started_at',
        'ended_at',
        sql<number>`row_number() over (partition by task_id order by created_at)::int`.as('number'),
      ])
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'desc')
      .execute()
    if (runs.length === 0) return []
    const runIds = runs.map((run) => run.id)
    const phases = await this.db
      .selectFrom('phases')
      .select([
        'id',
        'run_id',
        'name',
        'attempt',
        'agent',
        'model',
        'status',
        'summary_md',
        'started_at',
        'ended_at',
      ])
      .where('run_id', 'in', runIds)
      .orderBy('started_at')
      .execute()
    const artifacts = await this.db
      .selectFrom('artifacts')
      .select(['id', 'run_id', 'kind', 'phase_id', 'body_md', 'uri', 'data'])
      .where('run_id', 'in', runIds)
      .orderBy('created_at')
      .execute()
    return runs.map((run) => ({
      ...run,
      phases: phases.filter((p) => p.run_id === run.id).map(({ run_id: _r, ...phase }) => phase),
      artifacts: artifacts
        .filter((a) => a.run_id === run.id)
        .map(({ run_id: _r, ...artifact }) => artifact),
    }))
  }

  async taskOf(runId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('runs')
      .select('task_id')
      .where('id', '=', runId)
      .executeTakeFirst()
    return row?.task_id
  }

  async events(
    runId: string,
    after: { ts: Date; id: string } | undefined,
    limit: number,
  ): Promise<EventView[]> {
    let query = this.db
      .selectFrom('events')
      .select([
        'id',
        'phase_id',
        'ts',
        'type',
        'agent',
        'model',
        'tool',
        'target',
        'status',
        'duration_ms',
        'input',
        'output',
        'cache_read',
        'cache_write',
        'payload',
      ])
      .where('run_id', '=', runId)
    if (after !== undefined) {
      query = query.where((eb) => eb(eb.refTuple('ts', 'id'), '>', eb.tuple(after.ts, after.id)))
    }
    const rows = await query.orderBy('ts').orderBy('id').limit(limit).execute()
    return rows.map(({ input, output, cache_read, cache_write, ...rest }) => ({
      ...rest,
      usage: { input, output, cache_read, cache_write },
    }))
  }

  /** The latest run of each task, with the attempt its current phase is on. */
  async latestByTask(
    taskIds: string[],
  ): Promise<Map<string, { phase: string | null; attempt: number | null; pr_url: string | null }>> {
    if (taskIds.length === 0) return new Map()
    const runs = await this.db
      .selectFrom('runs')
      .select(['id', 'task_id', 'current_phase', 'pr_url'])
      .where('task_id', 'in', taskIds)
      .distinctOn('task_id')
      .orderBy('task_id')
      .orderBy('created_at', 'desc')
      .execute()
    const attempts =
      runs.length === 0
        ? []
        : await this.db
            .selectFrom('phases')
            .select(['run_id', 'name', (eb) => eb.fn.max('attempt').as('attempt')])
            .where(
              'run_id',
              'in',
              runs.map((run) => run.id),
            )
            .groupBy(['run_id', 'name'])
            .execute()
    return new Map(
      runs.map((run) => {
        const attempt =
          attempts.find((a) => a.run_id === run.id && a.name === run.current_phase)?.attempt ?? null
        return [run.task_id, { phase: run.current_phase, attempt, pr_url: run.pr_url }]
      }),
    )
  }
}
```

`server/src/modules/runs/run.service.ts`:

```ts
import { NotFoundError, ValidationError } from '../../shared/errors.js'
import type { EventView, RunRepository, RunView } from './run.repository.js'

/** `<ISO ts>|<id>` — the last event of a page, so the next starts strictly after it. */
function decodeCursor(cursor: string | undefined): { ts: Date; id: string } | undefined {
  if (cursor === undefined) return undefined
  const [ts, id] = cursor.split('|')
  const date = new Date(ts ?? '')
  if (id === undefined || Number.isNaN(date.getTime()))
    throw new ValidationError('after is not a cursor')
  return { ts: date, id }
}

export class RunService {
  constructor(private readonly runs: RunRepository) {}

  forTask(taskId: string): Promise<RunView[]> {
    return this.runs.forTask(taskId)
  }

  async get(runId: string): Promise<RunView> {
    const taskId = await this.runs.taskOf(runId)
    if (taskId === undefined) throw new NotFoundError('No such run')
    const run = (await this.runs.forTask(taskId)).find((r) => r.id === runId)
    if (run === undefined) throw new NotFoundError('No such run')
    return run
  }

  async events(
    runId: string,
    after: string | undefined,
    limit: number,
  ): Promise<{ events: EventView[]; next: string | null }> {
    const events = await this.runs.events(runId, decodeCursor(after), limit)
    const last = events.at(-1)
    return {
      events,
      next:
        events.length === limit && last !== undefined
          ? `${last.ts.toISOString()}|${last.id}`
          : null,
    }
  }
}
```

`server/src/modules/runs/run.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'
import { Uuid } from '../../shared/schemas.js'
import { TaskParams } from '../tasks/task.schemas.js'
import { RunRepository } from './run.repository.js'
import { RunService } from './run.service.js'

const RunParams = Type.Object({ id: Uuid })
const EventsQuery = Type.Object(
  {
    after: Type.Optional(Type.String({ maxLength: 100 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
)

export function registerRuns(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new RunService(new RunRepository(app.db))

  app.get('/api/tasks/:id/runs', { schema: { params: TaskParams } }, async (request) =>
    service.forTask(request.params.id),
  )
  app.get('/api/runs/:id', { schema: { params: RunParams } }, async (request) =>
    service.get(request.params.id),
  )
  app.get(
    '/api/runs/:id/events',
    { schema: { params: RunParams, querystring: EventsQuery } },
    async (request) =>
      service.events(request.params.id, request.query.after, request.query.limit ?? 500),
  )
}
```

`server/src/modules/costs/cost.service.ts`:

```ts
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { costOf, priceAt, type PriceRow } from './pricing.js'
import { summarizeCosts, type CostSummary } from './summarize.js'

export async function loadPrices(db: Kysely<Database>): Promise<PriceRow[]> {
  const rows = await db.selectFrom('prices').selectAll().execute()
  return rows.map((row) => ({
    model: row.model,
    effectiveFrom: row.effective_from.toISOString().slice(0, 10),
    input: Number(row.input),
    output: Number(row.output),
    cacheRead: Number(row.cache_read),
    cacheWrite: Number(row.cache_write),
  }))
}

export class CostService {
  constructor(private readonly db: Kysely<Database>) {}

  async forTask(taskId: string): Promise<CostSummary> {
    const events = await this.db
      .selectFrom('events')
      .innerJoin('runs', 'runs.id', 'events.run_id')
      .select([
        'events.phase_id',
        'events.agent',
        'events.model',
        'events.ts',
        'events.input',
        'events.output',
        'events.cache_read',
        'events.cache_write',
      ])
      .where('runs.task_id', '=', taskId)
      .where('events.model', 'is not', null)
      .execute()
    const phases = await this.db
      .selectFrom('phases')
      .innerJoin('runs', 'runs.id', 'phases.run_id')
      .select(['phases.id', 'phases.name', 'phases.attempt', 'phases.reported_cost'])
      .where('runs.task_id', '=', taskId)
      .orderBy('phases.started_at')
      .execute()
    return summarizeCosts({
      events: events.map((e) => ({
        phaseId: e.phase_id,
        agent: e.agent,
        model: e.model,
        ts: e.ts,
        usage: {
          input: e.input,
          output: e.output,
          cacheRead: e.cache_read,
          cacheWrite: e.cache_write,
        },
      })),
      phases: phases.map((p) => ({
        id: p.id,
        name: p.name,
        attempt: p.attempt,
        reportedCost: p.reported_cost,
      })),
      prices: await loadPrices(this.db),
    })
  }

  /** Dollars per task for the board: usage summed per model and day, then priced. */
  async totals(
    taskIds: string[],
  ): Promise<Map<string, { usd: number; complete: boolean; models: string[] }>> {
    const result = new Map<string, { usd: number; complete: boolean; models: string[] }>()
    if (taskIds.length === 0) return result
    const rows = await this.db
      .selectFrom('events')
      .innerJoin('runs', 'runs.id', 'events.run_id')
      .select((eb) => [
        'runs.task_id',
        'events.model',
        eb.fn<Date>('date_trunc', [eb.val('day'), eb.ref('events.ts')]).as('day'),
        eb.fn.sum<number>('events.input').as('input'),
        eb.fn.sum<number>('events.output').as('output'),
        eb.fn.sum<number>('events.cache_read').as('cache_read'),
        eb.fn.sum<number>('events.cache_write').as('cache_write'),
      ])
      .where('runs.task_id', 'in', taskIds)
      .where('events.model', 'is not', null)
      .groupBy(['runs.task_id', 'events.model', 'day'])
      .execute()
    const prices = await loadPrices(this.db)
    for (const row of rows) {
      const entry = result.get(row.task_id) ?? { usd: 0, complete: true, models: [] }
      const model = row.model ?? ''
      const price = priceAt(prices, model, new Date(row.day))
      if (price === undefined) entry.complete = false
      else
        entry.usd += costOf(
          {
            input: Number(row.input),
            output: Number(row.output),
            cacheRead: Number(row.cache_read),
            cacheWrite: Number(row.cache_write),
          },
          price,
        )
      if (!entry.models.includes(model)) entry.models.push(model)
      result.set(row.task_id, entry)
    }
    return result
  }
}
```

`server/src/modules/costs/cost.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { TaskParams } from '../tasks/task.schemas.js'
import { CostService } from './cost.service.js'

export function registerCosts(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new CostService(app.db)
  app.get('/api/tasks/:id/costs', { schema: { params: TaskParams } }, async (request) =>
    service.forTask(request.params.id),
  )
}
```

In `server/src/modules/tasks/task.repository.ts`, widen `TaskCard`:

```ts
export interface TaskCard {
  id: string
  key: string
  title: string
  state: TaskState
  position: number
  phase: string | null
  attempt: number | null
  models: string[]
  cost_usd: number
  cost_complete: boolean
  pr_url: string | null
}
```

and make `board()` return the base fields with `phase: null, attempt: null, models: [],
cost_usd: 0, cost_complete: true, pr_url: null`, which the service fills in. In
`server/src/modules/tasks/task.service.ts`, give the constructor two more parameters,
`private readonly runs: RunRepository, private readonly costs: CostService`, and replace `board`:

```ts
  async board(key: string): Promise<{ project: ProjectView; tasks: TaskCard[] }> {
    const project = await this.project(key)
    const cards = await this.tasks.board(project.id, project.key)
    const ids = cards.map((card) => card.id)
    const [latest, totals] = await Promise.all([this.runs.latestByTask(ids), this.costs.totals(ids)])
    return {
      project,
      tasks: cards.map((card) => {
        const run = latest.get(card.id)
        const cost = totals.get(card.id)
        return {
          ...card,
          phase: run?.phase ?? null,
          attempt: run?.attempt ?? null,
          pr_url: run?.pr_url ?? null,
          models: cost?.models ?? [],
          cost_usd: cost?.usd ?? 0,
          cost_complete: cost?.complete ?? true,
        }
      }),
    }
  }
```

and in `task.routes.ts` construct it with
`new TaskService(app.db, new TaskRepository(app.db), new ProjectRepository(app.db), new RunRepository(app.db), new CostService(app.db))`.
Register `registerRuns(app)` and `registerCosts(app)` in `server/src/app.ts` after `registerMcp(app)`.

- [ ] **Step 4: Run it to see it pass**

Run: `npm run --workspace server test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): read a run's timeline and costs, and show them on the card"
```

---

### Task 14: Cancel, Re-run, the PR poller, and entering prices

**Files:**

- Create: `server/src/modules/tasks/task.actions.ts`, `server/src/modules/runs/pr-poller.ts`,
  `server/scripts/set-price.ts`
- Modify: `server/src/modules/tasks/task.routes.ts`, `server/src/server.ts`, `server/package.json`, `run`
- Test: `server/tests/integration/actions.test.ts`, `server/tests/integration/pr-poller.test.ts`

**Interfaces:**

- Consumes: `moveTask`, `queueDeliveryRun`.
- Produces: `POST /api/tasks/:id/actions/:action` (`cancel` | `rerun`) → `TaskView`;
  `type Gh = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>`;
  `class PrPoller { constructor(db, gh: Gh, log: { warn(obj: object, msg: string): void }); tick(): Promise<void>;
start(intervalMs: number): void; stop(): void }`; `./run price:set <model> <input> <output>
<cache_read> <cache_write> [effective_from]`.

- [ ] **Step 1: Write the failing tests**

`server/tests/integration/actions.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const act = (taskId: string, action: string) =>
  app.inject({ method: 'POST', url: `/api/tasks/${taskId}/actions/${action}` })
const run = (runId: string) =>
  getTestDb().selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow()

describe('Cancel', () => {
  it('cancels a queued run outright', async () => {
    const { taskId, runId } = await seedQueuedRun(getTestDb())
    expect((await act(taskId, 'cancel')).json().state).toBe('failed')
    expect(await run(runId)).toMatchObject({
      status: 'cancelled',
      failure_reason: 'cancelled by the owner',
    })
  })

  it('asks the runner to stop a running run', async () => {
    const { taskId, runId } = await seedQueuedRun(getTestDb())
    await getTestDb()
      .updateTable('runs')
      .set({ status: 'running' })
      .where('id', '=', runId)
      .execute()
    await getTestDb()
      .updateTable('tasks')
      .set({ state: 'running' })
      .where('id', '=', taskId)
      .execute()
    expect((await act(taskId, 'cancel')).json().state).toBe('failed')
    expect(await run(runId)).toMatchObject({ status: 'running', cancel_requested: true })
  })

  it('answers 409 for a card with nothing to cancel', async () => {
    const { taskId } = await seedQueuedRun(getTestDb(), { state: 'review' })
    expect((await act(taskId, 'cancel')).statusCode).toBe(409)
  })
})

describe('Re-run', () => {
  it('queues a new delivery run of the approved spec', async () => {
    const { taskId } = await seedQueuedRun(getTestDb(), { state: 'failed' })
    expect((await act(taskId, 'rerun')).json().state).toBe('ready')
    const runs = await getTestDb()
      .selectFrom('runs')
      .select(['status', 'spec_version'])
      .where('task_id', '=', taskId)
      .orderBy('created_at')
      .execute()
    expect(runs).toEqual([
      { status: 'queued', spec_version: 1 },
      { status: 'queued', spec_version: 1 },
    ])
  })

  it('refuses an unknown action', async () => {
    const { taskId } = await seedQueuedRun(getTestDb())
    expect((await act(taskId, 'deploy')).statusCode).toBe(400)
  })
})
```

`server/tests/integration/pr-poller.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'
import { PrPoller, type Gh } from '../../src/modules/runs/pr-poller.js'

beforeEach(resetDb)
afterAll(closeTestDb)

const quiet = { warn: () => undefined }

async function inReview(prNumber: number) {
  const ids = await seedQueuedRun(getTestDb(), { state: 'review' })
  await getTestDb()
    .updateTable('runs')
    .set({
      status: 'succeeded',
      pr_number: prNumber,
      pr_url: `https://github.com/owner/pay/pull/${prNumber}`,
    })
    .where('id', '=', ids.runId)
    .execute()
  return ids
}

const state = async (taskId: string) =>
  (
    await getTestDb()
      .selectFrom('tasks')
      .select('state')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow()
  ).state

describe('PrPoller', () => {
  it.each([
    ['MERGED', 'done'],
    ['CLOSED', 'failed'],
    ['OPEN', 'review'],
  ])('moves a card whose PR is %s to %s', async (prState, expected) => {
    const { taskId } = await inReview(7)
    const calls: string[][] = []
    const gh: Gh = async (args) => {
      calls.push(args)
      return { code: 0, stdout: JSON.stringify({ state: prState }), stderr: '' }
    }
    await new PrPoller(getTestDb(), gh, quiet).tick()
    expect(calls).toEqual([['pr', 'view', '7', '--repo', 'owner/pay', '--json', 'state']])
    expect(await state(taskId)).toBe(expected)
  })

  it('leaves a card alone when gh fails, and says so', async () => {
    const { taskId } = await inReview(7)
    const warnings: string[] = []
    const gh: Gh = async () => ({ code: 1, stdout: '', stderr: 'HTTP 502' })
    await new PrPoller(getTestDb(), gh, { warn: (_obj, msg) => warnings.push(msg) }).tick()
    expect(await state(taskId)).toBe('review')
    expect(warnings).toEqual(['could not read a pull request'])
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run --workspace server test -- tests/integration/actions.test.ts tests/integration/pr-poller.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`server/src/modules/tasks/task.actions.ts`:

```ts
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { ConflictError } from '../../shared/errors.js'
import { queueDeliveryRun } from '../specs/spec.service.js'
import { moveTask } from './task.moves.js'

export const ACTIONS = ['cancel', 'rerun'] as const
export type Action = (typeof ACTIONS)[number]

export async function performAction(
  db: Kysely<Database>,
  taskId: string,
  action: Action,
  now: Date,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    if (action === 'cancel') {
      await moveTask(trx, taskId, 'cancel')
      const run = await trx
        .selectFrom('runs')
        .select(['id', 'status'])
        .where('task_id', '=', taskId)
        .where('status', 'in', ['queued', 'running'])
        .orderBy('created_at', 'desc')
        .executeTakeFirst()
      if (run === undefined) return
      // A queued run never started, so it ends here. A running one is stopped by the runner,
      // which learns of it in its next heartbeat and reports the run's end itself.
      await trx
        .updateTable('runs')
        .set(
          run.status === 'queued'
            ? { status: 'cancelled', ended_at: now, failure_reason: 'cancelled by the owner' }
            : { cancel_requested: true, failure_reason: 'cancelled by the owner' },
        )
        .where('id', '=', run.id)
        .execute()
      return
    }
    await moveTask(trx, taskId, 'rerun')
    const spec = await trx
      .selectFrom('specs')
      .select('version')
      .where('task_id', '=', taskId)
      .where('status', '=', 'approved')
      .orderBy('version', 'desc')
      .executeTakeFirst()
    if (spec === undefined) throw new ConflictError('This task has no approved spec to run')
    await queueDeliveryRun(trx, taskId, spec.version)
  })
}
```

In `server/src/modules/tasks/task.routes.ts`, add:

```ts
const ActionParams = Type.Object({
  id: Uuid,
  action: Type.Enum(ACTIONS),
})
app.post(
  '/api/tasks/:id/actions/:action',
  { schema: { params: ActionParams } },
  async (request) => {
    await performAction(app.db, request.params.id, request.params.action, app.clock())
    return service.get(request.params.id)
  },
)
```

with the imports `Type` from `typebox`, `Uuid` from `../../shared/schemas.js`, and
`ACTIONS, performAction` from `./task.actions.js`.

`server/src/modules/runs/pr-poller.ts`:

```ts
import { execFile } from 'node:child_process'
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { moveTask } from '../tasks/task.moves.js'

export type Gh = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export const realGh: Gh = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout,
        stderr,
      })
    })
  })

/** Moves cards in Review once their pull request is merged or closed on GitHub. */
export class PrPoller {
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly db: Kysely<Database>,
    private readonly gh: Gh,
    private readonly log: { warn(obj: object, msg: string): void },
  ) {}

  async tick(): Promise<void> {
    const rows = await this.db
      .selectFrom('tasks')
      .innerJoin('projects', 'projects.id', 'tasks.project_id')
      .innerJoin('runs', 'runs.task_id', 'tasks.id')
      .select(['tasks.id as taskId', 'runs.id as runId', 'runs.pr_number', 'projects.github_repo'])
      .where('tasks.state', '=', 'review')
      .where('runs.pr_number', 'is not', null)
      .distinctOn('tasks.id')
      .orderBy('tasks.id')
      .orderBy('runs.created_at', 'desc')
      .execute()
    for (const row of rows) {
      const result = await this.gh([
        'pr',
        'view',
        String(row.pr_number),
        '--repo',
        row.github_repo,
        '--json',
        'state',
      ])
      if (result.code !== 0) {
        this.log.warn(
          { taskId: row.taskId, stderr: result.stderr },
          'could not read a pull request',
        )
        continue
      }
      const { state } = JSON.parse(result.stdout) as { state: string }
      if (state === 'MERGED') await moveTask(this.db, row.taskId, 'merge')
      if (state === 'CLOSED') {
        await this.db.transaction().execute(async (trx) => {
          await moveTask(trx, row.taskId, 'close_pr')
          await trx
            .updateTable('runs')
            .set({ failure_reason: 'pull request closed without merging' })
            .where('id', '=', row.runId)
            .execute()
        })
      }
    }
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.log.warn({ err: error }, 'the PR poller failed'))
    }, intervalMs)
  }

  stop(): void {
    clearInterval(this.timer)
  }
}
```

In `server/src/server.ts`, after `buildApp`:

```ts
const poller = new PrPoller(db, realGh, app.log)
poller.start(config.prPollMs)
app.addHook('onClose', async () => poller.stop())
```

importing `PrPoller, realGh` from `./modules/runs/pr-poller.js`.

`server/scripts/set-price.ts`:

```ts
import { createDb } from '../src/db/client.js'

/**
 * USD per million tokens, from Anthropic's published price list. Cache writes are priced at
 * what Claude Code actually pays: its runs recorded on 2026-10-11 wrote with the one-hour TTL.
 */
const [
  model,
  input,
  output,
  cacheRead,
  cacheWrite,
  effectiveFrom = new Date().toISOString().slice(0, 10),
] = process.argv.slice(2)
const numbers = [input, output, cacheRead, cacheWrite].map(Number)
if (
  model === undefined ||
  numbers.some((n) => !Number.isFinite(n) || n < 0) ||
  !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)
) {
  console.error('usage: set-price <model> <input> <output> <cache_read> <cache_write> [YYYY-MM-DD]')
  process.exit(2)
}
const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(databaseUrl)
try {
  const [i, o, r, w] = numbers as [number, number, number, number]
  await db
    .insertInto('prices')
    .values({
      model,
      effective_from: effectiveFrom,
      input: i,
      output: o,
      cache_read: r,
      cache_write: w,
    })
    .onConflict((oc) =>
      oc
        .columns(['model', 'effective_from'])
        .doUpdateSet({ input: i, output: o, cache_read: r, cache_write: w }),
    )
    .execute()
  console.log(
    `${model} from ${effectiveFrom}: input ${i}, output ${o}, cache read ${r}, cache write ${w} USD/MTok`,
  )
} finally {
  await db.destroy()
}
```

Add to `server/package.json` scripts: `"price:set": "tsx scripts/set-price.ts"`. Add to `run`, a
scenario and its `case` line and usage line:

```bash
scenario_price_set() {
  need_node; need_deps; need_plugins; need_hooks; need_local_env
  start_db
  run_migrations
  ( cd server && DATABASE_URL="${DATABASE_URL:-$COMPOSE_DB_URL}" npx tsx scripts/set-price.ts "$@" )
}
```

```bash
  price:set)    scenario_price_set "$@" ;;
```

```
  ${BOLD}price:set${OFF}  record a model's price: <model> <input> <output> <cache_read> <cache_write> [from]
```

- [ ] **Step 4: Run them to see them pass**

Run: `npm run --workspace server test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server run
git commit -m "feat(server): cancel and re-run tasks, and follow their pull requests"
```

---

## Phase E — the runner

The runner has no build step: `bin/board-cli` runs `src/cli.ts` through `tsx`, and `tsc` only
type-checks. It is a tool on the owner's machine, never deployed.

### Task 15: The runner workspace, its configuration, the board client and the event sink

**Files:**

- Create: `runner/package.json`, `runner/tsconfig.json`, `runner/vitest.config.ts`,
  `runner/bin/board-cli`, `runner/src/config.ts`, `runner/src/contract.ts`, `runner/src/exec.ts`,
  `runner/src/api.ts`, `runner/src/sink.ts`
- Create through `charter init`: `runner/.claude/settings.json`
- Modify: `package.json` (workspaces), `run` (test and check), `charter.json`
- Test: `runner/tests/unit/config.test.ts`, `runner/tests/unit/sink.test.ts`

**Interfaces:**

- Produces:
  - `RunnerConfig { boardUrl: string; runnerKey: string; runnerId: string; claudeBin: string;
ghBin: string; home: string; testTimeoutMs: number; claimWaitMs: number; heartbeatMs: number }`,
    `loadRunnerConfig(env): RunnerConfig`.
  - `contract.ts`: `Usage`, `RunnerEvent`, `Work`, `RunView`, `ArtifactView`, `PlanData`,
    `ReportData`, `EventType`, `PhaseName` — the runner's copy of the server's wire shapes
    (Tasks 11–13), field for field.
  - `type Exec = (cmd: string, args: string[], options?: { cwd?: string; input?: string; timeoutMs?: number }) =>
Promise<{ code: number; stdout: string; stderr: string }>`; `realExec: Exec` (never rejects).
  - `class BoardApi { constructor(baseUrl: string, runnerKey: string, fetchImpl?: typeof fetch);
claim(runnerId, waitMs): Promise<Work | null>; heartbeat(runnerId, runIds): Promise<string[]>;
issueToken(runId): Promise<string>; getRun(runId): Promise<RunView>;
sendEvents(token, events): Promise<number>; retire(token): Promise<void> }`; `ApiError { status }`.
  - `class EventSink { constructor(api: BoardApi, file: string, token: () => string);
send(events: RunnerEvent[]): Promise<void>; flush(): Promise<void> }` — appends to `file` when
    the board cannot be reached and replays it, in order, before the next send.
  - `newEvent(base: { runId; phaseId; type; agent?; model? }, fields?, clock?, newId?): RunnerEvent` helper.

- [ ] **Step 1: Workspace files**

`runner/package.json`:

```json
{
  "name": "@board/runner",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24.0.0"
  },
  "bin": {
    "board-cli": "bin/board-cli"
  },
  "scripts": {
    "daemon": "bin/board-cli daemon",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^26.1.2",
    "tsx": "^4.23.1",
    "vitest": "^4.1.10"
  }
}
```

`runner/tsconfig.json` (type-checking only; the scenario tests import the server's sources):

```json
{
  "extends": "charter/stacks/node/tsconfig",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "tests"]
}
```

`runner/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
  },
})
```

`runner/bin/board-cli` (then `chmod +x runner/bin/board-cli`):

```sh
#!/bin/sh
# The runner is a tool on this machine, never deployed: it runs from source through tsx. Hooks
# call this file by its absolute path, from inside a worktree of another repository, so nothing
# here may depend on the working directory.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$DIR/../node_modules/.bin/tsx" "$DIR/src/cli.ts" "$@"
```

Root `package.json`: `"workspaces": ["server", "runner"]`. In `run`, replace `scenario_test`
and the type step of `scenario_check`:

```bash
scenario_test() {
  need_node; need_deps; need_plugins; need_hooks; need_docker
  step "Server suite"
  npm run --workspace server test
  step "Runner suite"
  npm run --workspace runner test
}
```

```bash
  step "Types"
  ( cd server && npx tsc --noEmit )
  ( cd runner && npx tsc --noEmit )
```

Then `npm install`, and record the runner's modules — the stacks without the `backend` domain,
since it serves no HTTP:

```bash
npx --no charter init typescript node vitest --workspace runner
```

Expected: `charter.json` gains `"runner": ["typescript", "node", "vitest"]`, and
`runner/.claude/settings.json` is written.

- [ ] **Step 2: Write the failing tests**

`runner/tests/unit/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { loadRunnerConfig } from '../../src/config.js'

const BASE = { RUNNER_KEY: 'k'.repeat(32) }

describe('loadRunnerConfig', () => {
  it('fills the defaults', () => {
    expect(loadRunnerConfig(BASE)).toEqual({
      boardUrl: 'http://127.0.0.1:4100',
      runnerKey: BASE.RUNNER_KEY,
      runnerId: hostname(),
      claudeBin: 'claude',
      ghBin: 'gh',
      home: join(homedir(), '.ai-task-board'),
      testTimeoutMs: 900_000,
      claimWaitMs: 30_000,
      heartbeatMs: 30_000,
    })
  })

  it('drops a trailing slash from the board URL', () => {
    expect(loadRunnerConfig({ ...BASE, BOARD_URL: 'http://127.0.0.1:4100/' }).boardUrl).toBe(
      'http://127.0.0.1:4100',
    )
  })

  it.each([
    ['no runner key', {}, /RUNNER_KEY/],
    ['a test timeout of zero', { ...BASE, TEST_TIMEOUT_MS: '0' }, /TEST_TIMEOUT_MS/],
  ])('refuses %s', (_name, env, message) => {
    expect(() => loadRunnerConfig(env)).toThrow(message)
  })
})
```

`runner/tests/unit/sink.test.ts`:

```ts
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BoardApi } from '../../src/api.js'
import { EventSink, newEvent } from '../../src/sink.js'

const RUN = '00000000-0000-4000-8000-0000000000aa'

function fakeBoard(down: { value: boolean }) {
  const received: string[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (down.value) throw new TypeError('fetch failed')
    const body = JSON.parse(String(init?.body)) as { events: { id: string }[] }
    received.push(...body.events.map((e) => e.id))
    return new Response(JSON.stringify({ accepted: body.events.length }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { api: new BoardApi('http://board', 'k'.repeat(32), fetchImpl), received }
}

describe('EventSink', () => {
  it('sends events straight through while the board answers', async () => {
    const { api, received } = fakeBoard({ value: false })
    const file = join(mkdtempSync(join(tmpdir(), 'sink-')), 'events.ndjson')
    const event = newEvent({ runId: RUN, phaseId: null, type: 'message' })
    await new EventSink(api, file, () => 't').send([event])
    expect(received).toEqual([event.id])
    expect(existsSync(file)).toBe(false)
  })

  // Review Focus 3: the board is down, then back; the buffer replays once, in order.
  it('buffers while the board is down and replays in order before the next send', async () => {
    const down = { value: true }
    const { api, received } = fakeBoard(down)
    const file = join(mkdtempSync(join(tmpdir(), 'sink-')), 'events.ndjson')
    const sink = new EventSink(api, file, () => 't')
    const [a, b, c] = [1, 2, 3].map(() => newEvent({ runId: RUN, phaseId: null, type: 'message' }))

    await sink.send([a!])
    await sink.send([b!])
    expect(received).toEqual([])
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2)

    down.value = false
    await sink.send([c!])
    expect(received).toEqual([a!.id, b!.id, c!.id])
    expect(readFileSync(file, 'utf8')).toBe('')
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm run --workspace runner test`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`runner/src/config.ts`:

```ts
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

export interface RunnerConfig {
  boardUrl: string
  runnerKey: string
  runnerId: string
  claudeBin: string
  ghBin: string
  /** Worktrees and run directories live here, outside every repository. */
  home: string
  testTimeoutMs: number
  claimWaitMs: number
  heartbeatMs: number
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`Invalid configuration: ${key} must be a positive integer`)
  return value
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv): RunnerConfig {
  const runnerKey = env.RUNNER_KEY?.trim()
  if (runnerKey === undefined || runnerKey === '')
    throw new Error('Invalid configuration: RUNNER_KEY is required')
  return {
    boardUrl: (env.BOARD_URL?.trim() || 'http://127.0.0.1:4100').replace(/\/+$/, ''),
    runnerKey,
    runnerId: env.RUNNER_ID?.trim() || hostname(),
    claudeBin: env.CLAUDE_BIN?.trim() || 'claude',
    ghBin: env.GH_BIN?.trim() || 'gh',
    home: env.BOARD_HOME?.trim() || join(homedir(), '.ai-task-board'),
    testTimeoutMs: positiveInt(env, 'TEST_TIMEOUT_MS', 900_000),
    claimWaitMs: positiveInt(env, 'CLAIM_WAIT_MS', 30_000),
    heartbeatMs: positiveInt(env, 'HEARTBEAT_MS', 30_000),
  }
}
```

`runner/src/contract.ts`:

```ts
/**
 * The runner's copy of the server's wire shapes. The scenario tests run the runner against the
 * real server; they are what catches the two drifting apart. Change both in one commit.
 */
export type PhaseName = 'spec' | 'plan' | 'build' | 'verify'
export type EventType =
  | 'phase_start'
  | 'phase_end'
  | 'message'
  | 'tool_call'
  | 'subagent_start'
  | 'subagent_stop'
  | 'approval_requested'
  | 'approval_answered'
  | 'checkpoint'
  | 'error'
  | 'run_end'

export interface Usage {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

export interface RunnerEvent {
  id: string
  run_id: string
  phase_id: string | null
  ts: string
  type: EventType
  agent: string | null
  model: string | null
  tool: string | null
  target: string | null
  status: string | null
  duration_ms: number | null
  usage: Usage
  payload: Record<string, unknown>
}

export interface SpecCriterion {
  id: string
  requirements: string[]
  text: string
}

export interface Work {
  kind: 'start'
  run: {
    id: string
    number: number
    kind: 'spec' | 'delivery'
    spec_version: number
    task: {
      id: string
      key: string
      title: string
      description_md: string
      budget_usd: number | null
    }
    spec: { version: number; body_md: string; criteria: SpecCriterion[] }
    project: {
      key: string
      repo_path: string
      github_repo: string
      base_branch: string
      test_command: string
    }
  }
}

export interface PlanData {
  summary: string
  confidence: 'high' | 'medium' | 'low'
  steps: { title: string; requirements: string[]; files: string[]; estimate_usd?: number }[]
  checks: { criterion: string; how: string }[]
}

export interface ReportData {
  summary: string
  criteria: { id: string; status: 'pass' | 'fail'; evidence: string }[]
}

export interface ArtifactView {
  id: string
  kind: 'plan' | 'verify_report' | 'pr'
  phase_id: string | null
  body_md: string
  uri: string | null
  data: unknown
}

export interface RunView {
  id: string
  status: string
  phases: { id: string; name: PhaseName; attempt: number; status: string }[]
  artifacts: ArtifactView[]
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
```

`runner/src/exec.ts`:

```ts
import { execFile } from 'node:child_process'

export type Exec = (
  cmd: string,
  args: string[],
  options?: { cwd?: string; input?: string; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>

/** Never rejects: a failing command is a result with a code, which callers decide about. */
export const realExec: Exec = (cmd, args, options = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ code, stdout, stderr: error !== null && stderr === '' ? error.message : stderr })
      },
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
```

`runner/src/api.ts`:

```ts
import type { RunnerEvent, RunView, Work } from './contract.js'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class BoardApi {
  constructor(
    private readonly baseUrl: string,
    private readonly runnerKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(
    method: string,
    path: string,
    credential: string | undefined,
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok)
      throw new ApiError(
        response.status,
        `${method} ${path} answered ${response.status}: ${await response.text()}`,
      )
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
  }

  async claim(runnerId: string, waitMs: number): Promise<Work | null> {
    return (
      await this.call<{ work: Work | null }>('POST', '/api/runner/claim', this.runnerKey, {
        runner_id: runnerId,
        wait_ms: waitMs,
      })
    ).work
  }

  async heartbeat(runnerId: string, runIds: string[]): Promise<string[]> {
    return (
      await this.call<{ cancel: string[] }>('POST', '/api/runner/heartbeat', this.runnerKey, {
        runner_id: runnerId,
        run_ids: runIds,
      })
    ).cancel
  }

  async issueToken(runId: string): Promise<string> {
    return (
      await this.call<{ token: string }>('POST', `/api/runner/runs/${runId}/tokens`, this.runnerKey)
    ).token
  }

  getRun(runId: string): Promise<RunView> {
    return this.call<RunView>('GET', `/api/runs/${runId}`, undefined)
  }

  async sendEvents(token: string, events: RunnerEvent[]): Promise<number> {
    return (await this.call<{ accepted: number }>('POST', '/api/runner/events', token, { events }))
      .accepted
  }

  async retire(token: string): Promise<void> {
    await this.call<void>('POST', '/api/runner/tokens/retire', token)
  }
}
```

`runner/src/sink.ts`:

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { BoardApi } from './api.js'
import { ApiError } from './api.js'
import { ZERO_USAGE, type EventType, type RunnerEvent } from './contract.js'

export function newEvent(
  base: {
    runId: string
    phaseId: string | null
    type: EventType
    agent?: string | null
    model?: string | null
  },
  fields: Partial<Omit<RunnerEvent, 'id' | 'run_id' | 'phase_id' | 'type'>> = {},
  clock: () => Date = () => new Date(),
  newId: () => string = randomUUID,
): RunnerEvent {
  return {
    id: newId(),
    run_id: base.runId,
    phase_id: base.phaseId,
    ts: clock().toISOString(),
    type: base.type,
    agent: base.agent ?? null,
    model: base.model ?? null,
    tool: null,
    target: null,
    status: null,
    duration_ms: null,
    usage: ZERO_USAGE,
    payload: {},
    ...fields,
  }
}

/** A network failure or a server error is worth retrying; a 4xx is the event's own fault. */
const retryable = (error: unknown) =>
  error instanceof TypeError || (error instanceof ApiError && error.status >= 500)

/**
 * Sends events to the board, keeping them in an ndjson file while it cannot be reached. Hooks
 * only ever append; the daemon is the one process that replays, so two replays never race.
 */
export class EventSink {
  constructor(
    private readonly api: BoardApi,
    private readonly file: string,
    private readonly token: () => string,
  ) {}

  async send(events: RunnerEvent[]): Promise<void> {
    if (events.length === 0) return
    try {
      await this.flush()
      await this.api.sendEvents(this.token(), events)
    } catch (error) {
      if (!retryable(error)) throw error
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, events.map((event) => `${JSON.stringify(event)}\n`).join(''))
    }
  }

  async flush(): Promise<void> {
    if (!existsSync(this.file)) return
    const lines = readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
    for (let start = 0; start < lines.length; start += 500) {
      const chunk = lines.slice(start, start + 500).map((line) => JSON.parse(line) as RunnerEvent)
      await this.api.sendEvents(this.token(), chunk)
      writeFileSync(
        this.file,
        lines
          .slice(start + 500)
          .map((line) => `${line}\n`)
          .join(''),
      )
    }
  }
}
```

- [ ] **Step 5: Run them to see them pass**

Run: `npm run --workspace runner test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json run charter.json runner
git commit -m "build(runner): add the runner workspace, its board client and event sink"
```

---

### Task 16: Recorded streams and the usage normalizer

**Files:**

- Create: `runner/scripts/record-stream.sh`, `runner/tests/fixtures/stream/plain.ndjson`,
  `runner/tests/fixtures/stream/subagent.ndjson` (both recorded, never edited),
  `runner/src/stream/normalize.ts`
- Test: `runner/tests/unit/normalize-fixtures.test.ts`, `runner/tests/unit/normalize.test.ts`

**Interfaces:**

- Consumes: `newEvent`, `RunnerEvent`, `Usage`.
- Produces: `class StreamNormalizer { constructor(options: { runId: string; phaseId: string; agent: string;
clock?: () => Date; newId?: () => string }); push(line: unknown): RunnerEvent[]; finish(): RunnerEvent[];
readonly sessionId: string | null; readonly result: ResultInfo | null; reportedCost(): Record<string, number> }`
  with `ResultInfo { text: string; isError: boolean; subtype: string; totalCostUsd: number;
modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number;
cacheCreationInputTokens: number; costUSD: number }> }`.

What the recordings of 2026-10-11 showed, and the normalizer follows:

| Source                                                                       | Use                                                                                                                          |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `stream_event` `message_start` / `message_delta`, `parent_tool_use_id: null` | the phase agent's usage, once per message; `message_delta.usage` is final                                                    |
| `assistant` events                                                           | never for usage: each content block repeats the message's usage, and `output_tokens` there is the count when streaming began |
| `user` event whose `tool_use_result` has `usage` and `agentType`             | a synchronous subagent's whole usage, under its own name                                                                     |
| the last `result`                                                            | `modelUsage` per model, cumulative for the process; the remainder after attribution becomes one `claude-code` event          |

- [ ] **Step 1: The recording script**

`runner/scripts/record-stream.sh` (then `chmod +x`):

```bash
#!/usr/bin/env bash
#
# Records the stream fixtures from the real claude CLI. Spends a few cents of the owner's
# account with Haiku, capped at $0.10 a recording. Re-run when Claude Code's output changes;
# never edit the fixtures by hand.
set -euo pipefail
OUT="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures/stream"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"
git -C "$WORK" init -q
echo '{"mcpServers":{}}' > "$WORK/mcp.json"

record() {
  local name="$1" prompt="$2"; shift 2
  ( cd "$WORK" && claude -p "$prompt" --model haiku --setting-sources project \
      --mcp-config "$WORK/mcp.json" --strict-mcp-config --max-budget-usd 0.10 \
      --include-partial-messages --output-format stream-json --verbose "$@" ) > "$OUT/$name.ndjson"
  echo "recorded $OUT/$name.ndjson ($(wc -l < "$OUT/$name.ndjson") lines)"
}

record plain "Reply with the single word ready."
record subagent "Call the echoer agent exactly once with the text 'ping', with run_in_background false, and wait for its answer. Then reply with the single word done." \
  --allowedTools Agent \
  --agents '{"echoer":{"description":"Echoes text back.","prompt":"Reply with the word pong and nothing else. Use no tools.","tools":["Read"],"model":"haiku"}}'
```

Run it once: `runner/scripts/record-stream.sh`. Expected: two files recorded, each ending in a
`"type":"result"` line. Check the subagent recording contains a completed subagent:
`grep -c '"agentType"' runner/tests/fixtures/stream/subagent.ndjson` prints at least `1`. If it
prints `0`, the model launched the subagent in the background; record again.

- [ ] **Step 2: Write the failing tests**

`runner/tests/unit/normalize-fixtures.test.ts` — every expectation is derived from the
recording itself, so a re-recording never needs the test edited:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StreamNormalizer } from '../../src/stream/normalize.js'
import type { RunnerEvent } from '../../src/contract.js'

const DIR = join(import.meta.dirname, '../fixtures/stream')
const lines = (name: string) =>
  readFileSync(join(DIR, `${name}.ndjson`), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)

function normalize(name: string) {
  const normalizer = new StreamNormalizer({ runId: 'r', phaseId: 'p', agent: 'planner' })
  const events: RunnerEvent[] = []
  for (const line of lines(name)) events.push(...normalizer.push(line))
  events.push(...normalizer.finish())
  return { normalizer, events }
}

function sumByModel(events: RunnerEvent[]) {
  const totals = new Map<
    string,
    { input: number; output: number; cache_read: number; cache_write: number }
  >()
  for (const e of events) {
    if (e.model === null) continue
    const t = totals.get(e.model) ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 }
    totals.set(e.model, {
      input: t.input + e.usage.input,
      output: t.output + e.usage.output,
      cache_read: t.cache_read + e.usage.cache_read,
      cache_write: t.cache_write + e.usage.cache_write,
    })
  }
  return totals
}

describe.each(['plain', 'subagent'])('the %s recording', (name) => {
  const { normalizer, events } = normalize(name)
  const result = normalizer.result!

  it('ends with a result the normalizer kept', () => {
    expect(result).not.toBeNull()
    expect(normalizer.sessionId).toEqual(expect.any(String))
  })

  // Over-counting — the same message counted per content block — makes a sum exceed the total,
  // and the remainder line cannot be negative, so this equality fails.
  it('accounts for exactly what Claude Code counted, per model and counter', () => {
    const sums = sumByModel(events)
    for (const [model, usage] of Object.entries(result.modelUsage)) {
      expect(sums.get(model)).toEqual({
        input: usage.inputTokens,
        output: usage.outputTokens,
        cache_read: usage.cacheReadInputTokens,
        cache_write: usage.cacheCreationInputTokens,
      })
    }
  })

  it('attributes every cache token to a message, leaving only input and output unattributed', () => {
    const overhead = events.filter((e) => e.agent === 'claude-code')
    for (const e of overhead) {
      expect(e.usage.cache_read).toBe(0)
      expect(e.usage.cache_write).toBe(0)
    }
  })

  it('reports Claude Code’s own cost per model', () => {
    expect(normalizer.reportedCost()).toEqual(
      Object.fromEntries(Object.entries(result.modelUsage).map(([m, u]) => [m, u.costUSD])),
    )
  })
})

describe('the subagent recording', () => {
  it('puts the subagent’s usage under its own name, exactly as its result reported it', () => {
    const recorded = lines('subagent')
      .map(
        (l) =>
          l.tool_use_result as { agentType?: string; usage?: Record<string, number> } | undefined,
      )
      .find((r) => r?.agentType !== undefined)!
    const { events } = normalize('subagent')
    const event = events.find((e) => e.agent === recorded.agentType)!
    expect(event.usage).toEqual({
      input: recorded.usage!.input_tokens,
      output: recorded.usage!.output_tokens,
      cache_read: recorded.usage!.cache_read_input_tokens,
      cache_write: recorded.usage!.cache_creation_input_tokens,
    })
  })
})
```

`runner/tests/unit/normalize.test.ts` — the rules, on lines small enough to read:

```ts
import { describe, expect, it } from 'vitest'
import { StreamNormalizer } from '../../src/stream/normalize.js'

const u = (input: number, output: number, cr = 0, cw = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cw,
})
const start = (model: string, usage: object, parent: string | null = null) => ({
  type: 'stream_event',
  parent_tool_use_id: parent,
  event: { type: 'message_start', message: { id: 'm', model, usage } },
})
const delta = (usage: object, parent: string | null = null) => ({
  type: 'stream_event',
  parent_tool_use_id: parent,
  event: { type: 'message_delta', usage },
})
const result = (modelUsage: Record<string, object>, cost = 0) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  total_cost_usd: cost,
  modelUsage,
})
const mu = (i: number, o: number, cr = 0, cw = 0, costUSD = 0) => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadInputTokens: cr,
  cacheCreationInputTokens: cw,
  costUSD,
})

function run(lines: object[]) {
  const n = new StreamNormalizer({ runId: 'r', phaseId: 'p', agent: 'planner' })
  const events = lines.flatMap((l) => n.push(l))
  return { n, events: [...events, ...n.finish()] }
}

describe('StreamNormalizer', () => {
  it('takes a message’s output from its delta, not its start', () => {
    const { events } = run([start('m', u(10, 2, 100, 5)), delta(u(10, 250, 100, 5))])
    expect(events[0]).toMatchObject({
      type: 'message',
      agent: 'planner',
      model: 'm',
      usage: { input: 10, output: 250, cache_read: 100, cache_write: 5 },
    })
  })

  it('never reads usage from assistant events', () => {
    const assistant = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'm', model: 'm', usage: u(10, 4), content: [{ type: 'text', text: 'x' }] },
    }
    expect(run([assistant, assistant]).events).toEqual([])
  })

  it('names a synchronous subagent after its type', () => {
    const user = {
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] },
      tool_use_result: {
        status: 'completed',
        agentId: 'a1',
        agentType: 'explorer',
        resolvedModel: 'h',
        usage: u(2000, 60),
      },
    }
    expect(run([user]).events[0]).toMatchObject({
      agent: 'explorer',
      model: 'h',
      usage: { input: 2000, output: 60 },
      payload: { subagent_id: 'a1', tool_use_id: 'toolu_1' },
    })
  })

  it('leaves a background subagent to the remainder, since it reports no usage', () => {
    const user = {
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [] },
      tool_use_result: { status: 'async_launched', agentId: 'a1' },
    }
    const { events } = run([user, result({ h: mu(500, 20) })])
    expect(events).toEqual([
      expect.objectContaining({
        agent: 'claude-code',
        model: 'h',
        usage: { input: 500, output: 20, cache_read: 0, cache_write: 0 },
        payload: { unattributed: true },
      }),
    ])
  })

  it('uses the last result of a process, which is cumulative', () => {
    const { n, events } = run([
      result({ m: mu(10, 1, 0, 0, 0.01) }, 0.01),
      result({ m: mu(30, 3, 0, 0, 0.03) }, 0.03),
    ])
    expect(n.result?.totalCostUsd).toBe(0.03)
    expect(events[0]?.usage).toEqual({ input: 30, output: 3, cache_read: 0, cache_write: 0 })
  })

  it('writes no remainder when everything was attributed', () => {
    const { events } = run([start('m', u(10, 1)), delta(u(10, 5)), result({ m: mu(10, 5) })])
    expect(events.filter((e) => e.agent === 'claude-code')).toEqual([])
  })

  it('reads the session id from the init line', () => {
    const { n } = run([{ type: 'system', subtype: 'init', session_id: 's-1', model: 'm' }])
    expect(n.sessionId).toBe('s-1')
  })

  it('ignores stream events that belong to a subagent', () => {
    expect(run([start('m', u(1, 1), 'toolu_9'), delta(u(1, 9), 'toolu_9')]).events).toEqual([])
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm run --workspace runner test -- tests/unit/normalize`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`runner/src/stream/normalize.ts`:

```ts
import { randomUUID } from 'node:crypto'
import type { RunnerEvent, Usage } from '../contract.js'
import { newEvent } from '../sink.js'

interface ApiUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUSD: number
}

export interface ResultInfo {
  text: string
  isError: boolean
  subtype: string
  totalCostUsd: number
  modelUsage: Record<string, ModelUsage>
}

type Line = Record<string, unknown>
const record = (value: unknown): Line | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Line) : undefined
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const toUsage = (u: ApiUsage | undefined): Usage => ({
  input: num(u?.input_tokens),
  output: num(u?.output_tokens),
  cache_read: num(u?.cache_read_input_tokens),
  cache_write: num(u?.cache_creation_input_tokens),
})

/**
 * Turns one `claude -p` process's stream-json into usage events, so that their sum per model is
 * exactly the `modelUsage` of the process's last result. See the plan's Task 16 for which line
 * carries what; the rules were read off recordings, not documentation.
 */
export class StreamNormalizer {
  sessionId: string | null = null
  result: ResultInfo | null = null
  private current: { model: string } | undefined
  private readonly attributed = new Map<string, Usage>()
  private readonly clock: () => Date
  private readonly newId: () => string

  constructor(
    private readonly options: {
      runId: string
      phaseId: string
      agent: string
      clock?: () => Date
      newId?: () => string
    },
  ) {
    this.clock = options.clock ?? (() => new Date())
    this.newId = options.newId ?? randomUUID
  }

  private emit(
    agent: string,
    model: string,
    usage: Usage,
    payload: Record<string, unknown>,
  ): RunnerEvent {
    const sum = this.attributed.get(model) ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 }
    this.attributed.set(model, {
      input: sum.input + usage.input,
      output: sum.output + usage.output,
      cache_read: sum.cache_read + usage.cache_read,
      cache_write: sum.cache_write + usage.cache_write,
    })
    return newEvent(
      { runId: this.options.runId, phaseId: this.options.phaseId, type: 'message', agent, model },
      { usage, payload },
      this.clock,
      this.newId,
    )
  }

  push(raw: unknown): RunnerEvent[] {
    const line = record(raw)
    if (line === undefined) return []
    switch (line.type) {
      case 'system':
        if (line.subtype === 'init' && typeof line.session_id === 'string')
          this.sessionId = line.session_id
        return []
      case 'stream_event': {
        if (line.parent_tool_use_id !== null && line.parent_tool_use_id !== undefined) return []
        const event = record(line.event)
        if (event?.type === 'message_start') {
          const message = record(event.message)
          this.current = { model: typeof message?.model === 'string' ? message.model : 'unknown' }
          return []
        }
        if (event?.type === 'message_delta' && this.current !== undefined) {
          const usage = toUsage(record(event.usage) as ApiUsage | undefined)
          const model = this.current.model
          this.current = undefined
          return [this.emit(this.options.agent, model, usage, {})]
        }
        return []
      }
      case 'user': {
        const result = record(line.tool_use_result)
        if (
          result === undefined ||
          typeof result.agentType !== 'string' ||
          record(result.usage) === undefined
        )
          return []
        const message = record(line.message)
        const content = Array.isArray(message?.content) ? message.content : []
        const toolResult = content.map(record).find((block) => block?.type === 'tool_result')
        return [
          this.emit(
            result.agentType,
            typeof result.resolvedModel === 'string' ? result.resolvedModel : 'unknown',
            toUsage(record(result.usage) as ApiUsage),
            {
              subagent_id: result.agentId ?? null,
              tool_use_id: toolResult?.tool_use_id ?? null,
            },
          ),
        ]
      }
      case 'result': {
        const usage = record(line.modelUsage) ?? {}
        const modelUsage: Record<string, ModelUsage> = {}
        for (const [model, value] of Object.entries(usage)) {
          const u = record(value) ?? {}
          modelUsage[model] = {
            inputTokens: num(u.inputTokens),
            outputTokens: num(u.outputTokens),
            cacheReadInputTokens: num(u.cacheReadInputTokens),
            cacheCreationInputTokens: num(u.cacheCreationInputTokens),
            costUSD: num(u.costUSD),
          }
        }
        this.result = {
          text: typeof line.result === 'string' ? line.result : '',
          isError: line.is_error === true,
          subtype: typeof line.subtype === 'string' ? line.subtype : 'unknown',
          totalCostUsd: num(line.total_cost_usd),
          modelUsage,
        }
        return []
      }
      default:
        return []
    }
  }

  /** The remainder per model: Claude Code's own calls and background subagents. */
  finish(): RunnerEvent[] {
    if (this.result === null) return []
    const events: RunnerEvent[] = []
    for (const [model, total] of Object.entries(this.result.modelUsage)) {
      const done = this.attributed.get(model) ?? {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
      }
      const rest: Usage = {
        input: Math.max(0, total.inputTokens - done.input),
        output: Math.max(0, total.outputTokens - done.output),
        cache_read: Math.max(0, total.cacheReadInputTokens - done.cache_read),
        cache_write: Math.max(0, total.cacheCreationInputTokens - done.cache_write),
      }
      if (rest.input + rest.output + rest.cache_read + rest.cache_write > 0) {
        events.push(this.emit('claude-code', model, rest, { unattributed: true }))
      }
    }
    return events
  }

  reportedCost(): Record<string, number> {
    return Object.fromEntries(
      Object.entries(this.result?.modelUsage ?? {}).map(([model, u]) => [model, u.costUSD]),
    )
  }
}
```

- [ ] **Step 5: Run them to see them pass**

Run: `npm run --workspace runner test -- tests/unit/normalize`
Expected: PASS. If "accounts for exactly what Claude Code counted" fails on a fresh recording,
read which counter is over: Claude Code's output changed, and the table above is what to
update — in the normalizer, this task's table and the spec's §4 together.

- [ ] **Step 6: Commit**

```bash
git add runner
git commit -m "feat(runner): count a phase's tokens exactly as claude reports them"
```

---

### Task 17: The hooks — the event hook and the guard

**Files:**

- Create: `runner/src/hooks/hook-event.ts`, `runner/src/hooks/guard.ts`, `runner/src/self.ts`,
  `runner/src/cli.ts`
- Test: `runner/tests/unit/hook-event.test.ts`, `runner/tests/unit/guard.test.ts`,
  `runner/tests/integration/cli-hooks.test.ts`

**Interfaces:**

- Consumes: `newEvent`, `EventSink`, `BoardApi`.
- Produces:
  - `hookToEvent(name: 'PostToolUse' | 'SubagentStart' | 'SubagentStop', input: Record<string, unknown>,
ctx: { runId: string; phaseId: string; agent: string }): RunnerEvent`.
  - `decide(input: { tool_name: string; tool_input: Record<string, unknown> }, ctx: { phase: string;
planFiles: string[] | null; cwd: string; exists: (path: string) => boolean }): { allow: true } | { allow: false; reason: string }`;
    `denyOutput(reason): string` — the JSON a `PreToolUse` hook prints to deny.
  - `CLI_PATH` — the absolute path of `runner/bin/board-cli`.
  - `board-cli event <PostToolUse|SubagentStart|SubagentStop>` and `board-cli guard`, reading the
    hook's JSON on stdin and these environment variables, which the phase runner sets:
    `BOARD_URL`, `BOARD_RUN_TOKEN`, `BOARD_RUN_ID`, `BOARD_PHASE_ID`, `BOARD_PHASE`,
    `BOARD_AGENT`, `BOARD_RUN_DIR`. The guard reads the plan's files from
    `$BOARD_RUN_DIR/plan-files.json` during Build.

The guard denies, with the reason the agent reads:

| Tool                                 | Denied                                                                                            | Reason                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Bash                                 | `rm -rf` / `rm -fr` in any spelling, `git push`, `git reset --hard`, any mention of a `.env` file | the rule it broke                                          |
| Edit, Write, MultiEdit, NotebookEdit | a path outside the worktree                                                                       | outside the worktree                                       |
| the same                             | a `.env*` file                                                                                    | secrets                                                    |
| Write                                | a new file under a `migrations` directory                                                         | migrations need a person (slice 2 makes it an approval)    |
| the same, in Build                   | a file not in the plan                                                                            | not in the plan; in slice 1 the agent must stop and say so |

- [ ] **Step 1: Write the failing tests**

`runner/tests/unit/guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { decide, denyOutput } from '../../src/hooks/guard.js'

const CWD = '/work/run-1'
const ctx = (
  phase = 'build',
  planFiles: string[] | null = ['src/retry.ts', 'src/retry.test.ts'],
) => ({
  phase,
  planFiles,
  cwd: CWD,
  exists: (path: string) => path !== '/work/run-1/db/migrations/002_new.ts',
})
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })
const edit = (file_path: string, tool_name = 'Edit') => ({ tool_name, tool_input: { file_path } })

describe('the guard', () => {
  it.each([
    'npm test',
    'git status',
    'git commit -m "x"',
    'rm src/old.ts',
    'cat README.md',
    'grep -r environment src',
  ])('allows the command %s', (command) => {
    expect(decide(bash(command), ctx())).toEqual({ allow: true })
  })

  it.each([
    ['rm -rf build', /rm -rf/],
    ['rm -fr build', /rm -rf/],
    ['rm -r -f build', /rm -rf/],
    ['rm --recursive --force build', /rm -rf/],
    ['git push origin HEAD', /push/],
    ['git push --force', /push/],
    ['cd x && git reset --hard HEAD~1', /reset --hard/],
    ['cat .env', /\.env/],
    ['cp .env.local /tmp/x', /\.env/],
  ])('denies the command %s', (command, reason) => {
    const verdict = decide(bash(command), ctx())
    expect(verdict.allow).toBe(false)
    if (!verdict.allow) expect(verdict.reason).toMatch(reason)
  })

  it.each([
    ['a planned file, relative', edit('src/retry.ts'), true],
    ['a planned file, absolute', edit('/work/run-1/src/retry.ts'), true],
    ['an unplanned file in Build', edit('src/other.ts'), false],
    ['an unplanned file in Plan', { ...edit('src/other.ts') }, true],
    ['a path outside the worktree', edit('/etc/hosts'), false],
    ['a path escaping with ..', edit('src/../../escape.ts'), false],
    ['an env file', edit('.env'), false],
    ['a nested env file', edit('config/.env.production'), false],
    ['a new migration', edit('db/migrations/002_new.ts', 'Write'), false],
    ['an existing migration, edited', edit('db/migrations/001_initial.ts'), true],
  ])('%s', (name, input, allowed) => {
    const phase = name.includes('in Plan') ? 'plan' : 'build'
    const planFiles = name.includes('migration')
      ? ['db/migrations/002_new.ts', 'db/migrations/001_initial.ts']
      : undefined
    expect(
      decide(input, ctx(phase, planFiles ?? ['src/retry.ts', 'src/retry.test.ts'])).allow,
    ).toBe(allowed)
  })

  it('denies with the JSON Claude Code reads', () => {
    expect(JSON.parse(denyOutput('because'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'because',
      },
    })
  })
})
```

`runner/tests/unit/hook-event.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { hookToEvent } from '../../src/hooks/hook-event.js'

const ctx = { runId: 'r', phaseId: 'p', agent: 'builder' }

describe('hookToEvent', () => {
  it.each([
    [
      'an edit',
      {
        tool_name: 'Edit',
        tool_input: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' },
        tool_response: {},
      },
      { tool: 'Edit', target: 'src/a.ts', status: 'ok' },
    ],
    [
      'a command',
      { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: '' } },
      { tool: 'Bash', target: 'npm test', status: 'ok' },
    ],
    [
      'a search',
      { tool_name: 'Grep', tool_input: { pattern: 'retry' }, tool_response: {} },
      { tool: 'Grep', target: 'retry', status: 'ok' },
    ],
    [
      'a failed tool',
      { tool_name: 'Bash', tool_input: { command: 'false' }, tool_response: { is_error: true } },
      { status: 'error' },
    ],
    [
      'a long command, cut to 200 characters',
      { tool_name: 'Bash', tool_input: { command: 'x'.repeat(500) }, tool_response: {} },
      { target: 'x'.repeat(200) },
    ],
  ])('records %s as a tool call', (_name, input, expected) => {
    expect(hookToEvent('PostToolUse', input, ctx)).toMatchObject({
      type: 'tool_call',
      agent: 'builder',
      phase_id: 'p',
      ...expected,
    })
  })

  it('records a subagent under its own type', () => {
    expect(
      hookToEvent('SubagentStart', { agent_id: 'a1', agent_type: 'explorer' }, ctx),
    ).toMatchObject({
      type: 'subagent_start',
      agent: 'explorer',
      payload: { agent_id: 'a1' },
    })
    expect(hookToEvent('SubagentStop', { agent_id: 'a1', agent_type: 'explorer' }, ctx).type).toBe(
      'subagent_stop',
    )
  })

  it('keeps no more than 4 KiB of a tool’s input', () => {
    const event = hookToEvent(
      'PostToolUse',
      {
        tool_name: 'Write',
        tool_input: { file_path: 'a', content: 'y'.repeat(10_000) },
        tool_response: {},
      },
      ctx,
    )
    expect(JSON.stringify(event.payload).length).toBeLessThan(4_200)
  })
})
```

`runner/tests/integration/cli-hooks.test.ts` — the real `bin/board-cli`, as Claude Code calls it:

```ts
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI_PATH } from '../../src/self.js'

function call(args: string[], input: object, env: Record<string, string>) {
  return spawnSync(CLI_PATH, args, {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    cwd: tmpdir(),
  })
}

describe('board-cli as a hook', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'))
  const env = {
    BOARD_URL: 'http://127.0.0.1:9', // nothing listens: the event must be buffered
    BOARD_RUN_TOKEN: 't',
    BOARD_RUN_ID: '00000000-0000-4000-8000-000000000001',
    BOARD_PHASE_ID: '00000000-0000-4000-8000-000000000002',
    BOARD_PHASE: 'build',
    BOARD_AGENT: 'builder',
    BOARD_RUN_DIR: runDir,
  }

  it('buffers a tool call when the board is unreachable, and exits 0 so the agent goes on', () => {
    const result = call(
      ['event', 'PostToolUse'],
      { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} },
      env,
    )
    expect(result.status).toBe(0)
    const buffered = readFileSync(join(runDir, 'events.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(buffered).toEqual([
      expect.objectContaining({ type: 'tool_call', tool: 'Bash', target: 'ls' }),
    ])
  })

  it('denies an edit outside the plan through stdout', () => {
    writeFileSync(join(runDir, 'plan-files.json'), JSON.stringify(['src/retry.ts']))
    const result = call(
      ['guard'],
      { cwd: runDir, tool_name: 'Edit', tool_input: { file_path: join(runDir, 'src/other.ts') } },
      env,
    )
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('stays silent to allow', () => {
    const result = call(
      ['guard'],
      { cwd: runDir, tool_name: 'Bash', tool_input: { command: 'npm test' } },
      env,
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})
```

The guard compares paths against the hook input's `cwd`, which Claude Code sets to the
worktree; the tests pass it explicitly, so they do not depend on where they run.

- [ ] **Step 2: Run them to see them fail**

Run: `npm run --workspace runner test -- tests/unit/guard.test.ts tests/unit/hook-event.test.ts tests/integration/cli-hooks.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`runner/src/hooks/guard.ts`:

```ts
import { isAbsolute, relative, resolve, sep, basename } from 'node:path'

export type Verdict = { allow: true } | { allow: false; reason: string }

const COMMAND_RULES: [RegExp, string][] = [
  [
    /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|(?:-r|--recursive)\s+(?:-f|--force)|(?:-f|--force)\s+(?:-r|--recursive))\b/,
    'rm -rf is not allowed in a run',
  ],
  [/\bgit\s+push\b/, 'agents never push; the runner pushes when Verify passes'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard is not allowed in a run'],
  [
    /(?:^|[\s'"/=])\.env(?:\.[\w.-]+)?(?=$|[\s'";|&)])/,
    '.env files hold secrets and are off limits',
  ],
]

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function deny(reason: string): Verdict {
  return { allow: false, reason }
}

export function decide(
  input: { tool_name: string; tool_input: Record<string, unknown> },
  ctx: {
    phase: string
    planFiles: string[] | null
    cwd: string
    exists: (path: string) => boolean
  },
): Verdict {
  if (input.tool_name === 'Bash') {
    const command = typeof input.tool_input.command === 'string' ? input.tool_input.command : ''
    for (const [pattern, reason] of COMMAND_RULES) if (pattern.test(command)) return deny(reason)
    return { allow: true }
  }

  if (!FILE_TOOLS.has(input.tool_name)) return { allow: true }
  const raw = input.tool_input.file_path ?? input.tool_input.notebook_path
  if (typeof raw !== 'string') return { allow: true }
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(ctx.cwd, raw)
  const inside = relative(ctx.cwd, absolute)
  if (inside.startsWith('..') || isAbsolute(inside))
    return deny('this path is outside the worktree')
  if (/^\.env(\..*)?$/.test(basename(absolute)))
    return deny('.env files hold secrets and are off limits')
  if (
    input.tool_name === 'Write' &&
    inside.split(sep).includes('migrations') &&
    !ctx.exists(absolute)
  ) {
    return deny(
      'a new migration needs a person; finish without it and say in your report that one is needed',
    )
  }
  if (
    ctx.phase === 'build' &&
    ctx.planFiles !== null &&
    !ctx.planFiles.includes(inside.split(sep).join('/'))
  ) {
    return deny(
      `${inside} is not in the plan. Do not change it; finish and say in your report which file the work needs and why.`,
    )
  }
  return { allow: true }
}

export function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })
}
```

`runner/src/hooks/hook-event.ts`:

```ts
import type { RunnerEvent } from '../contract.js'
import { newEvent } from '../sink.js'

const MAX_INPUT = 4_096

function target(input: Record<string, unknown>): string | null {
  for (const key of [
    'file_path',
    'notebook_path',
    'command',
    'pattern',
    'url',
    'path',
    'description',
  ]) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value.slice(0, 200)
  }
  return null
}

function failed(response: unknown): boolean {
  if (typeof response !== 'object' || response === null) return false
  const r = response as Record<string, unknown>
  return r.is_error === true || r.success === false || r.interrupted === true
}

export function hookToEvent(
  name: 'PostToolUse' | 'SubagentStart' | 'SubagentStop',
  input: Record<string, unknown>,
  ctx: { runId: string; phaseId: string; agent: string },
): RunnerEvent {
  const base = { runId: ctx.runId, phaseId: ctx.phaseId }
  if (name === 'PostToolUse') {
    const toolInput =
      typeof input.tool_input === 'object' && input.tool_input !== null
        ? (input.tool_input as Record<string, unknown>)
        : {}
    const serialized = JSON.stringify(toolInput)
    return newEvent(
      {
        ...base,
        type: 'tool_call',
        agent: typeof input.agent_type === 'string' ? input.agent_type : ctx.agent,
      },
      {
        tool: typeof input.tool_name === 'string' ? input.tool_name : null,
        target: target(toolInput),
        status: failed(input.tool_response) ? 'error' : 'ok',
        payload: {
          tool_use_id: input.tool_use_id ?? null,
          input: serialized.length > MAX_INPUT ? `${serialized.slice(0, MAX_INPUT)}…` : toolInput,
        },
      },
    )
  }
  return newEvent(
    {
      ...base,
      type: name === 'SubagentStart' ? 'subagent_start' : 'subagent_stop',
      agent: typeof input.agent_type === 'string' ? input.agent_type : null,
    },
    { payload: { agent_id: input.agent_id ?? null } },
  )
}
```

`runner/src/self.ts`:

```ts
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** `runner/bin/board-cli`, found by walking up from this file, wherever it is run from. */
function find(): string {
  let dir = import.meta.dirname
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'bin', 'board-cli')
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  throw new Error('bin/board-cli not found above src/self.ts')
}

export const CLI_PATH = find()
```

`runner/src/cli.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BoardApi } from './api.js'
import { decide, denyOutput } from './hooks/guard.js'
import { hookToEvent } from './hooks/hook-event.js'
import { EventSink } from './sink.js'

function env(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '')
    throw new Error(`${name} is not set; board-cli hooks run only inside a phase`)
  return value
}

async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
}

/**
 * A hook must never fail the agent's tool call for a reason of the board's own: the event is
 * buffered and the hook exits 0. Only the guard's verdict changes what the agent may do.
 */
async function event(name: string): Promise<void> {
  if (name !== 'PostToolUse' && name !== 'SubagentStart' && name !== 'SubagentStop')
    throw new Error(`unknown hook ${name}`)
  const input = await readStdin()
  const runDir = env('BOARD_RUN_DIR')
  const sink = new EventSink(
    new BoardApi(env('BOARD_URL'), ''),
    join(runDir, 'events.ndjson'),
    () => env('BOARD_RUN_TOKEN'),
  )
  const ctx = {
    runId: env('BOARD_RUN_ID'),
    phaseId: env('BOARD_PHASE_ID'),
    agent: env('BOARD_AGENT'),
  }
  try {
    await sink.send([hookToEvent(name, input, ctx)])
  } catch (error) {
    process.stderr.write(`board-cli: event not recorded: ${String(error)}\n`)
  }
}

async function guard(): Promise<void> {
  const input = await readStdin()
  const runDir = env('BOARD_RUN_DIR')
  const planPath = join(runDir, 'plan-files.json')
  const verdict = decide(
    {
      tool_name: typeof input.tool_name === 'string' ? input.tool_name : '',
      tool_input:
        typeof input.tool_input === 'object' && input.tool_input !== null
          ? (input.tool_input as Record<string, unknown>)
          : {},
    },
    {
      phase: env('BOARD_PHASE'),
      planFiles: existsSync(planPath)
        ? (JSON.parse(readFileSync(planPath, 'utf8')) as string[])
        : null,
      cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
      exists: existsSync,
    },
  )
  if (!verdict.allow) process.stdout.write(denyOutput(verdict.reason))
}

const [command, ...args] = process.argv.slice(2)
if (command === 'event') await event(args[0] ?? '')
else if (command === 'guard') await guard()
else {
  process.stderr.write('usage: board-cli event <PostToolUse|SubagentStart|SubagentStop> | guard\n')
  process.exit(2)
}
```

The `daemon` command arrives with `daemon.ts` in Task 20, so nothing imports a module that does
not exist yet.

- [ ] **Step 4: Run them to see them pass**

Run: `npm run --workspace runner test && grep -l "db/" runner/src/hooks/guard.ts`
Expected: PASS; `grep` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add runner
git commit -m "feat(runner): record tool calls from hooks and guard what agents touch"
```

---

### Task 18: One phase — agents, handoff, arguments, run directory, and the process

**Files:**

- Create: `runner/src/phases/agents.ts`, `handoff.ts`, `claude-args.ts`, `run-dir.ts`, `phase.ts`
- Test: `runner/tests/unit/handoff.test.ts`, `runner/tests/unit/claude-args.test.ts`,
  `runner/tests/integration/phase.test.ts`, `runner/tests/fake/stream-replay.ts`

**Interfaces:**

- Consumes: `StreamNormalizer`, `EventSink`, `BoardApi`, `newEvent`, `CLI_PATH`.
- Produces:
  - `PHASES: Record<'plan' | 'build' | 'verify', PhaseConfig>` with
    `PhaseConfig { agent: string; model: string; effort: string; permissionMode: 'default' | 'acceptEdits'; tools: string[] }`;
    `AGENTS: Record<string, { description: string; prompt: string; tools: string[]; model: string }>`.
  - `buildHandoff(input: HandoffInput): string` with `HandoffInput { taskKey: string; title: string;
phase: 'plan' | 'build' | 'verify'; attempt: number; specVersion: number; specMd: string;
budgetUsd: number | null; summaries: { phase: string; attempt: number; text: string }[];
plan?: string; verifyReport?: string; testOutput?: string; diff?: string }`.
  - `buildClaudeArgs(input: ClaudeArgsInput): string[]` with `ClaudeArgsInput { prompt: string;
sessionId: string; role: string; model: string; effort: string; permissionMode: string;
tools: string[]; agentsJson: string; settingsPath: string; mcpPath: string; budgetUsd: number | null }`.
  - `prepareRunDir(dir: string): void` (writes `agents.json`, `settings.json` and `mcp.json`;
    the board URL and token reach `mcp.json` through the environment);
    `writePlanFiles(dir: string, files: string[]): void`.
  - `runPhase(input: PhaseInput, deps: PhaseDeps): Promise<PhaseResult>` with
    `PhaseInput { runId; phase: 'plan' | 'build' | 'verify'; attempt; handoff; worktree; runDir; budgetUsd: number | null }`,
    `PhaseDeps { api: BoardApi; sink: EventSink; claudeBin: string; boardUrl: string; signal?: AbortSignal; setToken(token: string): void }`,
    `PhaseResult { phaseId: string; ok: boolean; summary: string; sessionId: string | null; cancelled: boolean }`.

- [ ] **Step 1: Write the failing unit tests**

`runner/tests/unit/claude-args.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildClaudeArgs } from '../../src/phases/claude-args.js'

const BASE = {
  prompt: '<task/>',
  sessionId: '11111111-1111-4111-8111-111111111111',
  role: 'builder',
  model: 'sonnet',
  effort: 'medium',
  permissionMode: 'acceptEdits',
  tools: ['Read', 'Edit'],
  agentsJson: '{"builder":{}}',
  settingsPath: '/run/settings.json',
  mcpPath: '/run/mcp.json',
  budgetUsd: null,
}

describe('buildClaudeArgs', () => {
  it('builds the spec’s one-phase call, flag for flag', () => {
    expect(buildClaudeArgs(BASE)).toEqual([
      '-p',
      '<task/>',
      '--session-id',
      '11111111-1111-4111-8111-111111111111',
      '--agents',
      '{"builder":{}}',
      '--agent',
      'builder',
      '--model',
      'sonnet',
      '--effort',
      'medium',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Read,Edit',
      '--settings',
      '/run/settings.json',
      '--mcp-config',
      '/run/mcp.json',
      '--strict-mcp-config',
      '--setting-sources',
      'project',
      '--include-partial-messages',
      '--output-format',
      'stream-json',
      '--verbose',
    ])
  })

  it('caps the phase’s spend when the task has a budget', () => {
    const args = buildClaudeArgs({ ...BASE, budgetUsd: 3 })
    expect(
      args.slice(args.indexOf('--max-budget-usd'), args.indexOf('--max-budget-usd') + 2),
    ).toEqual(['--max-budget-usd', '3'])
  })
})
```

`runner/tests/unit/handoff.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildHandoff } from '../../src/phases/handoff.js'

const BASE = {
  taskKey: 'PAY-42',
  title: 'Retry <webhooks> & more',
  phase: 'build' as const,
  attempt: 2,
  specVersion: 3,
  specMd: '## Requirements\n1. R1 – x',
  budgetUsd: 3,
  summaries: [{ phase: 'plan', attempt: 1, text: 'Planned two steps' }],
}

describe('buildHandoff', () => {
  it('follows the platform design’s handoff contract, escaping text', () => {
    const text = buildHandoff({ ...BASE, plan: '1. Backoff', verifyReport: '| AC1 | ✘ fail |' })
    expect(text).toContain(
      '<task id="PAY-42" phase="build" attempt="2">Retry &lt;webhooks&gt; &amp; more</task>',
    )
    expect(text).toContain('<spec version="3">')
    expect(text).toContain('<summary phase="plan" attempt="1">Planned two steps</summary>')
    expect(text).toContain('<verify_report>')
    expect(text).toContain('<budget usd="3.00"/>')
    expect(text).toContain('<return_format>')
  })

  it('cuts a huge diff to its first 60,000 characters and says so', () => {
    const text = buildHandoff({ ...BASE, phase: 'verify', diff: 'd'.repeat(100_000) })
    expect(text).toContain('[diff cut: 40000 more characters]')
  })

  it('omits sections it was not given', () => {
    const text = buildHandoff({
      ...BASE,
      phase: 'plan',
      attempt: 1,
      summaries: [],
      budgetUsd: null,
    })
    expect(text).not.toContain('<diff>')
    expect(text).not.toContain('<budget')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run --workspace runner test -- tests/unit/claude-args.test.ts tests/unit/handoff.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the pieces**

`runner/src/phases/agents.ts`:

```ts
const BOARD = (tools: string[]) => tools.map((tool) => `mcp__board__${tool}`)

export interface PhaseConfig {
  agent: string
  model: string
  effort: string
  permissionMode: 'default' | 'acceptEdits'
  tools: string[]
}

export const PHASES: Record<'plan' | 'build' | 'verify', PhaseConfig> = {
  plan: {
    agent: 'planner',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: 'default',
    tools: [
      'Read',
      'Grep',
      'Glob',
      'Agent',
      ...BOARD(['get_task', 'get_spec', 'save_plan', 'log_step']),
    ],
  },
  build: {
    agent: 'builder',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: 'acceptEdits',
    tools: ['Read', 'Edit', 'Write', 'Bash', ...BOARD(['get_task', 'get_spec', 'log_step'])],
  },
  verify: {
    agent: 'verifier',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: 'default',
    tools: [
      'Read',
      'Grep',
      'Glob',
      'Bash',
      'Agent',
      ...BOARD(['get_task', 'get_spec', 'save_report', 'log_step']),
    ],
  },
}

const SUBAGENTS =
  'When you use the explorer agent, always pass run_in_background: false and wait for its answer.'

export const AGENTS: Record<
  string,
  { description: string; prompt: string; tools: string[]; model: string }
> = {
  planner: {
    description: 'Plans a task against its approved spec.',
    model: 'sonnet',
    tools: PHASES.plan.tools,
    prompt: [
      'You plan one task of a board. The handoff in the first message carries the approved spec; get_spec and get_task return it again if needed.',
      'Read the code before planning. Use the explorer agent for searching and reading so that your own context stays small.',
      SUBAGENTS,
      'Save the plan with save_plan. Every step names the requirements it serves (R1, R2…) and every file it will touch, by path relative to the repository root. Every acceptance criterion gets a check. Estimate each step in USD.',
      'Set confidence to high only when the spec leaves you no choice to make. If save_plan refuses the plan, fix what it names and save again.',
      'Do not edit any file. Finish with one paragraph summarising the plan.',
    ].join('\n\n'),
  },
  builder: {
    description: 'Implements an approved plan.',
    model: 'sonnet',
    tools: PHASES.build.tools,
    prompt: [
      'You implement one task of a board, following the plan in the handoff.',
      'Change only the files the plan lists; any other edit will be refused. If the work needs a file the plan does not list, do not work around it: finish and say in your report which file and why.',
      'Write or update the tests the plan names, run them, and commit your work with git commit. Never push and never rewrite history.',
      'If the handoff carries a failing verify report, fix exactly what it says failed.',
      'Finish with <build_report status="done|blocked" files="…" tests="…" confidence="high|medium|low"/> and one paragraph.',
    ].join('\n\n'),
  },
  verifier: {
    description: 'Checks a diff against the spec’s acceptance criteria.',
    model: 'sonnet',
    tools: PHASES.verify.tools,
    prompt: [
      'You verify one task of a board. You did not write this code; judge it only by the spec, the diff and the test output in the handoff.',
      'For every acceptance criterion decide pass or fail, with evidence: a test name, a line of the diff, a command and its output. You may run read-only commands to check; do not edit files.',
      SUBAGENTS,
      'Save your verdicts with save_report, one per criterion. If it refuses the report, fix what it names and save again. Finish with one paragraph.',
    ].join('\n\n'),
  },
  explorer: {
    description:
      'Searches and reads the codebase and logs; answers briefly with paths and line numbers.',
    model: 'haiku',
    tools: ['Read', 'Grep', 'Glob'],
    prompt:
      'Answer the question you are given from the code. Be brief: paths, line numbers, and what you found. Do not speculate.',
  },
}
```

`runner/src/phases/handoff.ts`:

```ts
export interface HandoffInput {
  taskKey: string
  title: string
  phase: 'plan' | 'build' | 'verify'
  attempt: number
  specVersion: number
  specMd: string
  budgetUsd: number | null
  summaries: { phase: string; attempt: number; text: string }[]
  plan?: string
  verifyReport?: string
  testOutput?: string
  diff?: string
}

const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const attr = (text: string) => escape(text).replaceAll('"', '&quot;')

function cut(label: string, text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[${label} cut: ${text.length - max} more characters]`
}

const RETURNS: Record<HandoffInput['phase'], string> = {
  plan: 'Call save_plan, then reply with one paragraph.',
  build:
    '<build_report status="done|blocked" files="…" tests="…" confidence="high|medium|low"/> and one paragraph.',
  verify: 'Call save_report with a verdict on every criterion, then reply with one paragraph.',
}

/** The platform design's handoff contract: the same tags for every phase. */
export function buildHandoff(input: HandoffInput): string {
  const parts = [
    `<task id="${attr(input.taskKey)}" phase="${input.phase}" attempt="${input.attempt}">${escape(input.title)}</task>`,
    `<spec version="${input.specVersion}">\n${escape(input.specMd)}\n</spec>`,
  ]
  if (input.summaries.length > 0) {
    parts.push(
      `<context>\n${input.summaries.map((s) => `<summary phase="${s.phase}" attempt="${s.attempt}">${escape(s.text)}</summary>`).join('\n')}\n</context>`,
    )
  }
  if (input.plan !== undefined) parts.push(`<plan>\n${escape(input.plan)}\n</plan>`)
  if (input.verifyReport !== undefined)
    parts.push(`<verify_report>\n${escape(input.verifyReport)}\n</verify_report>`)
  if (input.testOutput !== undefined)
    parts.push(
      `<test_output>\n${escape(cut('test output', input.testOutput, 20_000))}\n</test_output>`,
    )
  if (input.diff !== undefined)
    parts.push(`<diff>\n${escape(cut('diff', input.diff, 60_000))}\n</diff>`)
  parts.push(
    '<constraints>Work only inside this worktree. Never push. Stop and say so in your reply if the spec cannot be met as written.</constraints>',
  )
  if (input.budgetUsd !== null) parts.push(`<budget usd="${input.budgetUsd.toFixed(2)}"/>`)
  parts.push(`<return_format>${escape(RETURNS[input.phase])}</return_format>`)
  return parts.join('\n')
}
```

`runner/src/phases/claude-args.ts`:

```ts
export interface ClaudeArgsInput {
  prompt: string
  sessionId: string
  role: string
  model: string
  effort: string
  permissionMode: string
  tools: string[]
  agentsJson: string
  settingsPath: string
  mcpPath: string
  budgetUsd: number | null
}

/** The spec's §6 call. `--setting-sources project` keeps the owner's plugins and hooks out. */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  return [
    '-p',
    input.prompt,
    '--session-id',
    input.sessionId,
    '--agents',
    input.agentsJson,
    '--agent',
    input.role,
    '--model',
    input.model,
    '--effort',
    input.effort,
    '--permission-mode',
    input.permissionMode,
    '--allowedTools',
    input.tools.join(','),
    '--settings',
    input.settingsPath,
    '--mcp-config',
    input.mcpPath,
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    ...(input.budgetUsd === null ? [] : ['--max-budget-usd', String(input.budgetUsd)]),
    '--include-partial-messages',
    '--output-format',
    'stream-json',
    '--verbose',
  ]
}
```

`runner/src/phases/run-dir.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLI_PATH } from '../self.js'
import { AGENTS } from './agents.js'

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

/** Everything a phase needs that must not end up in the target repository. */
export function prepareRunDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const command = (args: string) => ({ type: 'command', command: `${quote(CLI_PATH)} ${args}` })
  writeFileSync(join(dir, 'agents.json'), JSON.stringify(AGENTS))
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [{ matcher: '*', hooks: [command('guard')] }],
          PostToolUse: [{ matcher: '*', hooks: [command('event PostToolUse')] }],
          SubagentStart: [{ hooks: [command('event SubagentStart')] }],
          SubagentStop: [{ hooks: [command('event SubagentStop')] }],
        },
      },
      null,
      2,
    ),
  )
  // The URL and token are read from the process environment when Claude Code loads this file,
  // so the token never touches the disk.
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        board: {
          type: 'http',
          url: '${BOARD_URL}/mcp',
          headers: { Authorization: 'Bearer ${BOARD_RUN_TOKEN}' },
        },
      },
    }),
  )
}

export function writePlanFiles(dir: string, files: string[]): void {
  writeFileSync(join(dir, 'plan-files.json'), JSON.stringify(files))
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npm run --workspace runner test -- tests/unit/claude-args.test.ts tests/unit/handoff.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing phase test**

`runner/tests/fake/stream-replay.ts` — a stand-in for `claude` that prints a recorded stream,
used where only the process contract matters:

```ts
// Usage: stream-replay <fixture> [--noise] [--exit <code>] [...claude's own flags, ignored]
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const fixture = args[0]!
const sessionId = args[args.indexOf('--session-id') + 1] ?? 'session'
if (args.includes('--noise'))
  process.stdout.write('Warning: something the CLI says that is not JSON\n\n')
for (const line of readFileSync(fixture, 'utf8').split('\n')) {
  if (line === '') continue
  const parsed = JSON.parse(line) as Record<string, unknown>
  if ('session_id' in parsed) parsed.session_id = sessionId
  process.stdout.write(`${JSON.stringify(parsed)}\n`)
}
process.stderr.write('a line on stderr\n')
const exit = args.indexOf('--exit')
process.exit(exit === -1 ? 0 : Number(args[exit + 1]))
```

`runner/tests/integration/phase.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BoardApi } from '../../src/api.js'
import type { RunnerEvent } from '../../src/contract.js'
import { runPhase } from '../../src/phases/phase.js'
import { prepareRunDir } from '../../src/phases/run-dir.js'
import { EventSink } from '../../src/sink.js'

const FIXTURE = join(import.meta.dirname, '../fixtures/stream/plain.ndjson')
const REPLAY = join(import.meta.dirname, '../fake/stream-replay.ts')
const TSX = join(import.meta.dirname, '../../../node_modules/.bin/tsx')

/** A shell script standing in for `claude`, passing its flags to the replay after its own. */
function fakeClaude(extra: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'claude-')), 'claude')
  writeFileSync(path, `#!/bin/sh\nexec "${TSX}" "${REPLAY}" "${FIXTURE}" ${extra} "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

function recordingApi() {
  const events: RunnerEvent[] = []
  const tokens: string[] = []
  const api = {
    issueToken: async () => {
      tokens.push(`t${tokens.length}`)
      return tokens.at(-1)!
    },
    retire: async () => undefined,
    sendEvents: async (_t: string, batch: RunnerEvent[]) => {
      events.push(...batch)
      return batch.length
    },
  } as unknown as BoardApi
  return { api, events }
}

async function phase(extra = '') {
  const runDir = mkdtempSync(join(tmpdir(), 'rundir-'))
  prepareRunDir(runDir)
  const { api, events } = recordingApi()
  let token = ''
  const result = await runPhase(
    {
      runId: '00000000-0000-4000-8000-000000000001',
      phase: 'plan',
      attempt: 1,
      handoff: '<task/>',
      worktree: tmpdir(),
      runDir,
      budgetUsd: null,
    },
    {
      api,
      sink: new EventSink(api, join(runDir, 'events.ndjson'), () => token),
      claudeBin: fakeClaude(extra),
      boardUrl: 'http://127.0.0.1:1',
      setToken: (t) => {
        token = t
      },
    },
  )
  return { result, events, runDir }
}

describe('runPhase', () => {
  it('reports the phase’s start, its usage and its end with Claude Code’s own cost', async () => {
    const { result, events } = await phase()
    expect(result.ok).toBe(true)
    expect(events[0]).toMatchObject({
      type: 'phase_start',
      agent: 'planner',
      model: 'sonnet',
      payload: { name: 'plan', attempt: 1 },
    })
    expect(events.filter((e) => e.type === 'message').length).toBeGreaterThan(0)
    const end = events.at(-1)!
    expect(end).toMatchObject({
      type: 'phase_end',
      payload: { status: 'succeeded', session_id: result.sessionId },
    })
    expect(
      Object.values(end.payload.reported_cost as Record<string, number>).every((usd) => usd > 0),
    ).toBe(true)
  })

  // Review Focus 2.
  it('keeps going past a line that is not JSON, and keeps the line', async () => {
    const { result, runDir } = await phase('--noise')
    expect(result.ok).toBe(true)
    expect(readFileSync(join(runDir, 'plan-1.stdout-noise.log'), 'utf8')).toContain(
      'Warning: something the CLI says',
    )
  })

  it('fails the phase on a non-zero exit, with the end of stderr', async () => {
    const { result, events } = await phase('--exit 3')
    expect(result.ok).toBe(false)
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      payload: { exit_code: 3, stderr_tail: expect.stringContaining('a line on stderr') },
    })
    expect(events.at(-1)).toMatchObject({ type: 'phase_end', payload: { status: 'failed' } })
  })
})
```

- [ ] **Step 6: Run it to see it fail**

Run: `npm run --workspace runner test -- tests/integration/phase.test.ts`
Expected: FAIL — `phase.js` not found.

- [ ] **Step 7: Implement the phase runner**

`runner/src/phases/phase.ts`:

```ts
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { BoardApi } from '../api.js'
import { EventSink, newEvent } from '../sink.js'
import { StreamNormalizer } from '../stream/normalize.js'
import { PHASES } from './agents.js'
import { buildClaudeArgs } from './claude-args.js'

export interface PhaseInput {
  runId: string
  phase: 'plan' | 'build' | 'verify'
  attempt: number
  handoff: string
  worktree: string
  runDir: string
  budgetUsd: number | null
}

export interface PhaseDeps {
  api: BoardApi
  sink: EventSink
  claudeBin: string
  boardUrl: string
  signal?: AbortSignal
  /** The sink reads the token through this, so buffered events replay with a live one. */
  setToken(token: string): void
}

export interface PhaseResult {
  phaseId: string
  ok: boolean
  summary: string
  sessionId: string | null
  cancelled: boolean
}

const STDERR_LINES = 50

export async function runPhase(input: PhaseInput, deps: PhaseDeps): Promise<PhaseResult> {
  const config = PHASES[input.phase]
  const phaseId = randomUUID()
  const sessionId = randomUUID()
  const label = `${input.phase}-${input.attempt}`
  const base = { runId: input.runId, phaseId, agent: config.agent }

  const token = await deps.api.issueToken(input.runId)
  deps.setToken(token)
  await deps.sink.send([
    newEvent(
      { ...base, type: 'phase_start', model: config.model },
      { payload: { name: input.phase, attempt: input.attempt, session_id: sessionId } },
    ),
  ])

  const normalizer = new StreamNormalizer({ runId: input.runId, phaseId, agent: config.agent })
  const args = buildClaudeArgs({
    prompt: input.handoff,
    sessionId,
    role: config.agent,
    model: config.model,
    effort: config.effort,
    permissionMode: config.permissionMode,
    tools: config.tools,
    agentsJson: readFileSync(join(input.runDir, 'agents.json'), 'utf8'),
    settingsPath: join(input.runDir, 'settings.json'),
    mcpPath: join(input.runDir, 'mcp.json'),
    budgetUsd: input.budgetUsd,
  })
  const child = spawn(deps.claudeBin, args, {
    cwd: input.worktree,
    env: {
      ...process.env,
      BOARD_URL: deps.boardUrl,
      BOARD_RUN_TOKEN: token,
      BOARD_RUN_ID: input.runId,
      BOARD_PHASE_ID: phaseId,
      BOARD_PHASE: input.phase,
      BOARD_AGENT: config.agent,
      BOARD_RUN_DIR: input.runDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let cancelled = false
  const onAbort = () => {
    cancelled = true
    child.kill('SIGTERM')
  }
  deps.signal?.addEventListener('abort', onAbort, { once: true })

  const stderr: string[] = []
  createInterface({ input: child.stderr }).on('line', (line) => {
    appendFileSync(join(input.runDir, `${label}.stderr.log`), `${line}\n`)
    stderr.push(line)
    if (stderr.length > STDERR_LINES) stderr.shift()
  })

  // Lines are handled in order; a slow send never reorders two events.
  let pending = Promise.resolve()
  createInterface({ input: child.stdout }).on('line', (line) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      appendFileSync(join(input.runDir, `${label}.stdout-noise.log`), `${line}\n`)
      return
    }
    const events = normalizer.push(parsed)
    if (events.length > 0) pending = pending.then(() => deps.sink.send(events))
  })

  const exitCode = await new Promise<number>((resolve) =>
    child.on('close', (code) => resolve(code ?? 1)),
  )
  deps.signal?.removeEventListener('abort', onAbort)
  await pending

  const result = normalizer.result
  const ok = !cancelled && exitCode === 0 && result !== null && !result.isError
  const closing = [...normalizer.finish()]
  if (!ok && !cancelled) {
    closing.push(
      newEvent(
        { ...base, type: 'error' },
        {
          payload: {
            exit_code: exitCode,
            subtype: result?.subtype ?? null,
            stderr_tail: stderr.join('\n'),
          },
        },
      ),
    )
  }
  closing.push(
    newEvent(
      { ...base, type: 'phase_end' },
      {
        payload: {
          status: ok ? 'succeeded' : 'failed',
          summary_md: result?.text ?? '',
          reported_cost: normalizer.reportedCost(),
          session_id: normalizer.sessionId ?? sessionId,
        },
      },
    ),
  )
  await deps.sink.send(closing)
  await deps.api.retire(token).catch(() => undefined)
  return {
    phaseId,
    ok,
    summary: result?.text ?? '',
    sessionId: normalizer.sessionId ?? sessionId,
    cancelled,
  }
}
```

- [ ] **Step 8: Run it to see it pass**

Run: `npm run --workspace runner test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add runner
git commit -m "feat(runner): run one phase as one claude call and report what it spent"
```

---

### Task 19: Git, the pull request, and the test command

**Files:**

- Create: `runner/src/git.ts`, `runner/src/test-command.ts`, `runner/tests/fake/fake-gh`,
  `runner/tests/integration/target-repo.ts`
- Test: `runner/tests/integration/git.test.ts`, `runner/tests/integration/test-command.test.ts`

**Interfaces:**

- Consumes: `Exec`, `realExec`.
- Produces:
  - `class GitError extends Error { readonly command: string; readonly output: string }`.
  - `class Git { constructor(exec: Exec, ghBin: string); prepareWorktree(repo, base, branch, dir): Promise<void>;
newCommits(dir, base): Promise<number>; diff(dir, base): Promise<string>; push(dir, branch): Promise<void>;
createPr(dir, pr: { githubRepo; base; branch; title; body }): Promise<{ number: number; url: string }>;
removeWorktree(repo, dir): Promise<void> }`.
  - `runTestCommand(command: string, cwd: string, options: { timeoutMs: number; maxBytes?: number }):
Promise<{ exitCode: number | null; timedOut: boolean; output: string; truncated: boolean; durationMs: number }>`.
  - Test helpers `targetRepository(): { remote: string; repo: string }` and `useTestGitIdentity(): void`.

- [ ] **Step 1: The fake `gh`**

`runner/tests/fake/fake-gh` (then `chmod +x`):

```sh
#!/bin/sh
# Stands in for `gh pr create`: swallows the body from stdin, records the call, prints a URL.
cat > /dev/null
[ -n "$FAKE_GH_LOG" ] && echo "$@" >> "$FAKE_GH_LOG"
echo "https://github.com/owner/pay/pull/${FAKE_GH_PR_NUMBER:-7}"
```

- [ ] **Step 2: Write the failing tests**

`runner/tests/integration/target-repo.ts` — shared with the scenario tests in Task 21:

```ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
```

`runner/tests/integration/git.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { realExec } from '../../src/exec.js'
import { Git, GitError } from '../../src/git.js'
import { targetRepository, useTestGitIdentity } from './target-repo.js'

const FAKE_GH = join(import.meta.dirname, '../fake/fake-gh')
const git = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, encoding: 'utf8' })

beforeAll(useTestGitIdentity)

describe('Git', () => {
  it('takes a run from a fresh worktree to a pushed branch and a pull request', async () => {
    const { remote, repo } = targetRepository()
    const subject = new Git(realExec, FAKE_GH)
    const worktree = join(mkdtempSync(join(tmpdir(), 'wt-')), 'run')

    await subject.prepareWorktree(repo, 'main', 'board/PAY-1-r1', worktree)
    expect(readFileSync(join(worktree, 'src/retry.ts'), 'utf8')).toContain('delays')
    expect(await subject.newCommits(worktree, 'main')).toBe(0)

    writeFileSync(join(worktree, 'src/retry.ts'), 'export const delays = [1, 2, 4]\n')
    git(['commit', '-q', '-am', 'back off'], worktree)
    expect(await subject.newCommits(worktree, 'main')).toBe(1)
    expect(await subject.diff(worktree, 'main')).toContain('+export const delays = [1, 2, 4]')

    await subject.push(worktree, 'board/PAY-1-r1')
    expect(git(['ls-remote', remote, 'board/PAY-1-r1'])).toContain('refs/heads/board/PAY-1-r1')

    const log = join(tmpdir(), `gh-${Date.now()}.log`)
    process.env.FAKE_GH_LOG = log
    expect(
      await subject.createPr(worktree, {
        githubRepo: 'owner/pay',
        base: 'main',
        branch: 'board/PAY-1-r1',
        title: 'PAY-1: Retry',
        body: 'report',
      }),
    ).toEqual({ number: 7, url: 'https://github.com/owner/pay/pull/7' })
    expect(readFileSync(log, 'utf8')).toContain(
      'pr create --repo owner/pay --base main --head board/PAY-1-r1 --title PAY-1: Retry --body-file -',
    )

    await subject.removeWorktree(repo, worktree)
    expect(existsSync(worktree)).toBe(false)
  })

  it('names the command and its output when git fails', async () => {
    const subject = new Git(realExec, FAKE_GH)
    const error = await subject
      .prepareWorktree('/does/not/exist', 'main', 'b', join(tmpdir(), 'never'))
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).command).toBe('git -C /does/not/exist fetch origin main')
    expect((error as GitError).output).not.toBe('')
  })
})
```

`runner/tests/integration/test-command.test.ts`:

```ts
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { runTestCommand } from '../../src/test-command.js'

describe('runTestCommand', () => {
  it.each([
    ['a passing command', 'echo ok', 0, 'ok\n'],
    ['a failing command', 'echo broken >&2; exit 3', 3, 'broken\n'],
  ])('reports %s with its output', async (_name, command, exitCode, output) => {
    const run = await runTestCommand(command, tmpdir(), { timeoutMs: 10_000 })
    expect(run).toMatchObject({ exitCode, timedOut: false, output, truncated: false })
  })

  // Review Focus 5: megabytes of output keep only their tail.
  it('keeps only the last 64 KiB of a flood of output', async () => {
    const run = await runTestCommand('yes line | head -c 1000000; echo THE-END', tmpdir(), {
      timeoutMs: 30_000,
    })
    expect(run.truncated).toBe(true)
    expect(Buffer.byteLength(run.output)).toBeLessThanOrEqual(65_536)
    expect(run.output.endsWith('THE-END\n')).toBe(true)
  })

  // Review Focus 5: a command that never ends is stopped, with everything it ran.
  it('stops a command that outlives its timeout, children included', async () => {
    const started = Date.now()
    const run = await runTestCommand('echo started; sleep 30 & sleep 30', tmpdir(), {
      timeoutMs: 300,
    })
    expect(run).toMatchObject({ timedOut: true, exitCode: null })
    expect(run.output).toContain('started')
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm run --workspace runner test -- tests/integration/git.test.ts tests/integration/test-command.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`runner/src/git.ts`:

```ts
import type { Exec } from './exec.js'

export class GitError extends Error {
  constructor(
    readonly command: string,
    readonly output: string,
  ) {
    super(`${command} failed: ${output}`)
  }
}

export class Git {
  constructor(
    private readonly exec: Exec,
    private readonly ghBin: string,
  ) {}

  private async run(
    cmd: string,
    args: string[],
    options: { cwd?: string; input?: string } = {},
  ): Promise<string> {
    const result = await this.exec(cmd, args, options)
    if (result.code !== 0)
      throw new GitError(
        `${cmd === this.ghBin ? 'gh' : cmd} ${args.join(' ')}`,
        (result.stderr || result.stdout).trim(),
      )
    return result.stdout
  }

  /** A new branch from the remote's base, so the run never starts from local, unpushed work. */
  async prepareWorktree(repo: string, base: string, branch: string, dir: string): Promise<void> {
    await this.run('git', ['-C', repo, 'fetch', 'origin', base])
    await this.run('git', ['-C', repo, 'worktree', 'add', '-b', branch, dir, `origin/${base}`])
  }

  async newCommits(dir: string, base: string): Promise<number> {
    return Number(
      (await this.run('git', ['-C', dir, 'rev-list', '--count', `origin/${base}..HEAD`])).trim(),
    )
  }

  diff(dir: string, base: string): Promise<string> {
    return this.run('git', ['-C', dir, 'diff', `origin/${base}...HEAD`])
  }

  async push(dir: string, branch: string): Promise<void> {
    await this.run('git', ['-C', dir, 'push', '-u', 'origin', branch])
  }

  async createPr(
    dir: string,
    pr: { githubRepo: string; base: string; branch: string; title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    const out = await this.run(
      this.ghBin,
      [
        'pr',
        'create',
        '--repo',
        pr.githubRepo,
        '--base',
        pr.base,
        '--head',
        pr.branch,
        '--title',
        pr.title,
        '--body-file',
        '-',
      ],
      { cwd: dir, input: pr.body },
    )
    const url = out.trim().split('\n').at(-1) ?? ''
    const match = /\/pull\/(\d+)$/.exec(url)
    if (match?.[1] === undefined)
      throw new GitError('gh pr create', `no pull request URL in: ${out.trim()}`)
    return { number: Number(match[1]), url }
  }

  async removeWorktree(repo: string, dir: string): Promise<void> {
    await this.run('git', ['-C', repo, 'worktree', 'remove', '--force', dir])
  }
}
```

`runner/src/test-command.ts`:

```ts
import { spawn } from 'node:child_process'

export interface TestRun {
  exitCode: number | null
  timedOut: boolean
  output: string
  truncated: boolean
  durationMs: number
}

/**
 * The project's own test command, run by the runner rather than an agent, so Verify always
 * sees what the suite says. Output and time are bounded: a flood keeps its tail, which is where
 * a test runner prints its summary, and a hang is killed with everything it started.
 */
export function runTestCommand(
  command: string,
  cwd: string,
  options: { timeoutMs: number; maxBytes?: number },
): Promise<TestRun> {
  const maxBytes = options.maxBytes ?? 65_536
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = Buffer.alloc(0)
    let truncated = false
    const keep = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > maxBytes) {
        buffer = buffer.subarray(buffer.length - maxBytes)
        truncated = true
      }
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)

    let timedOut = false
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal)
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill('SIGTERM')
      setTimeout(() => kill('SIGKILL'), 5_000).unref()
    }, options.timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      // A cut may land inside a multi-byte character; drop the broken start rather than show it.
      const output = buffer.toString('utf8').replace(/^�+/, '')
      resolve({
        exitCode: timedOut ? null : code,
        timedOut,
        output,
        truncated,
        durationMs: Date.now() - started,
      })
    })
  })
}
```

- [ ] **Step 5: Run them to see them pass**

Run: `npm run --workspace runner test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add runner
git commit -m "feat(runner): prepare worktrees, open pull requests, bound the tests"
```

---

### Task 20: The delivery run and the daemon

**Files:**

- Create: `runner/src/delivery.ts`, `runner/src/daemon.ts`
- Modify: `runner/src/cli.ts` (the `daemon` command)
- Test: `runner/tests/unit/delivery.test.ts`

**Interfaces:**

- Consumes: everything in Tasks 15–19.
- Produces:
  - `runDelivery(work: Work, deps: DeliveryDeps): Promise<'review' | 'failed' | 'cancelled'>` with
    `DeliveryDeps { api: BoardApi; git: Git; sink: EventSink; setToken(token: string): void;
runPhase: (input: PhaseInput, deps: PhaseDeps) => Promise<PhaseResult>;
runTests: typeof runTestCommand; config: RunnerConfig; signal: AbortSignal }`.
  - `class Daemon { constructor(config: RunnerConfig, overrides?: Partial<{ api: BoardApi; git: Git; runPhase; runTests }>);
runOnce(): Promise<boolean>; loop(stop: AbortSignal): Promise<void> }`; `main(): Promise<void>`.
  - `npm run --workspace runner daemon` starts it.

The run, step by step:

1. Issue a token for the run itself (so `run_end` can be sent even if the first git step fails),
   write the run directory, create the worktree on `board/<KEY>-r<number>`.
2. Plan, attempt 1. No plan artifact on that phase → Failed, "the planner saved no plan".
   Write `plan-files.json` from the plan.
3. For attempts 1–3: Build → count new commits → run the test command (recorded as a
   `tool_call` by agent `runner`, tool `test_command`) → no commit: the attempt counts as a
   failed verify → Verify → its report. All pass → push, PR, `run_end` review. Otherwise the
   report goes to the next Build.
4. A failed phase, a missing report, or a `git`/`gh` failure → `run_end` failed with the reason;
   a cancel → `run_end` cancelled.
5. The worktree is removed at every run end. The spec keeps it until Done or Failed so that a
   paused run can resume; nothing pauses before slice 2, so this plan removes it as soon as
   the run ends, and slice 2 keeps the worktrees of paused runs.

- [ ] **Step 1: Write the failing test**

`runner/tests/unit/delivery.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BoardApi } from '../../src/api.js'
import type { ArtifactView, RunnerEvent, Work } from '../../src/contract.js'
import { runDelivery, type DeliveryDeps } from '../../src/delivery.js'
import { Git, GitError } from '../../src/git.js'
import type { PhaseInput, PhaseResult } from '../../src/phases/phase.js'
import { EventSink } from '../../src/sink.js'

const WORK: Work = {
  kind: 'start',
  run: {
    id: '00000000-0000-4000-8000-000000000001',
    number: 2,
    kind: 'delivery',
    spec_version: 1,
    task: { id: 't', key: 'PAY-1', title: 'Retry', description_md: '', budget_usd: null },
    spec: {
      version: 1,
      body_md: '## Requirements\n1. R1 – x',
      criteria: [{ id: 'AC1', requirements: ['R1'], text: 'x' }],
    },
    project: {
      key: 'PAY',
      repo_path: '/repo',
      github_repo: 'owner/pay',
      base_branch: 'main',
      test_command: 'npm test',
    },
  },
}

type Verdict = 'pass' | 'fail' | 'no-report'
interface Script {
  plan?: 'ok' | 'no-plan' | 'fails'
  commits?: number[]
  verdicts?: Verdict[]
  push?: 'ok' | 'fails'
  cancelIn?: 'build'
}

function harness(script: Script) {
  const sent: RunnerEvent[] = []
  const artifacts: ArtifactView[] = []
  const handoffs: { phase: string; attempt: number; handoff: string }[] = []
  const gitCalls: string[] = []
  let build = 0
  let verify = 0

  const api = {
    issueToken: async () => 'token',
    retire: async () => undefined,
    sendEvents: async (_t: string, events: RunnerEvent[]) => {
      sent.push(...events)
      return events.length
    },
    getRun: async () => ({ id: WORK.run.id, status: 'running', phases: [], artifacts }),
  } as unknown as BoardApi

  const runPhase = async (input: PhaseInput): Promise<PhaseResult> => {
    handoffs.push({ phase: input.phase, attempt: input.attempt, handoff: input.handoff })
    const phaseId = `${input.phase}-${input.attempt}`
    if (input.phase === 'plan') {
      if (script.plan === 'fails')
        return { phaseId, ok: false, summary: '', sessionId: 's', cancelled: false }
      if (script.plan !== 'no-plan') {
        artifacts.push({
          id: 'a',
          kind: 'plan',
          phase_id: phaseId,
          body_md: '1. Backoff',
          uri: null,
          data: {
            summary: 's',
            confidence: 'high',
            steps: [{ title: 'b', requirements: ['R1'], files: ['src/retry.ts'] }],
            checks: [{ criterion: 'AC1', how: 'test' }],
          },
        })
      }
    }
    if (input.phase === 'build') {
      build += 1
      if (script.cancelIn === 'build')
        return { phaseId, ok: false, summary: '', sessionId: 's', cancelled: true }
    }
    if (input.phase === 'verify') {
      const verdict = script.verdicts?.[verify++] ?? 'pass'
      if (verdict !== 'no-report') {
        artifacts.push({
          id: `r${verify}`,
          kind: 'verify_report',
          phase_id: phaseId,
          body_md: `| AC1 | ${verdict} |`,
          uri: null,
          data: { summary: 's', criteria: [{ id: 'AC1', status: verdict, evidence: 'e' }] },
        })
      }
    }
    return {
      phaseId,
      ok: true,
      summary: `${input.phase} ${input.attempt} done`,
      sessionId: 's',
      cancelled: false,
    }
  }

  const git = {
    prepareWorktree: async (_r: string, _b: string, branch: string) => {
      gitCalls.push(`worktree ${branch}`)
    },
    newCommits: async () => script.commits?.[build - 1] ?? 1,
    diff: async () => '+change',
    push: async (_d: string, branch: string) => {
      if (script.push === 'fails') throw new GitError(`git push -u origin ${branch}`, 'rejected')
      gitCalls.push(`push ${branch}`)
    },
    createPr: async () => {
      gitCalls.push('pr')
      return { number: 9, url: 'https://github.com/owner/pay/pull/9' }
    },
    removeWorktree: async () => {
      gitCalls.push('remove')
    },
  } as unknown as Git

  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const deps: DeliveryDeps = {
    api,
    git,
    sink: new EventSink(api, join(home, 'events.ndjson'), () => 'token'),
    setToken: () => undefined,
    runPhase,
    runTests: async () => ({
      exitCode: 0,
      timedOut: false,
      output: 'tests ok',
      truncated: false,
      durationMs: 5,
    }),
    config: {
      boardUrl: 'http://b',
      runnerKey: 'k',
      runnerId: 'r',
      claudeBin: 'claude',
      ghBin: 'gh',
      home,
      testTimeoutMs: 1000,
      claimWaitMs: 1,
      heartbeatMs: 1000,
    },
    signal: new AbortController().signal,
  }
  return { deps, sent, handoffs, gitCalls, runEnd: () => sent.find((e) => e.type === 'run_end') }
}

describe('runDelivery', () => {
  it('plans, builds, verifies, and opens the pull request', async () => {
    const h = harness({})
    expect(await runDelivery(WORK, h.deps)).toBe('review')
    expect(h.handoffs.map((x) => `${x.phase}-${x.attempt}`)).toEqual([
      'plan-1',
      'build-1',
      'verify-1',
    ])
    expect(h.gitCalls).toEqual(['worktree board/PAY-1-r2', 'push board/PAY-1-r2', 'pr', 'remove'])
    expect(h.runEnd()).toMatchObject({
      payload: { outcome: 'review', pr_number: 9, branch: 'board/PAY-1-r2' },
    })
    expect(h.sent.find((e) => e.tool === 'test_command')).toMatchObject({
      type: 'tool_call',
      agent: 'runner',
      status: 'ok',
      target: 'npm test',
    })
  })

  it('hands a failing report to the next build, and gives up after the third', async () => {
    const h = harness({ verdicts: ['fail', 'fail', 'fail'] })
    expect(await runDelivery(WORK, h.deps)).toBe('failed')
    expect(h.handoffs.map((x) => `${x.phase}-${x.attempt}`)).toEqual([
      'plan-1',
      'build-1',
      'verify-1',
      'build-2',
      'verify-2',
      'build-3',
      'verify-3',
    ])
    expect(h.handoffs[3]?.handoff).toContain('<verify_report>')
    expect(h.runEnd()).toMatchObject({
      payload: { outcome: 'failed', reason: 'verify failed three times' },
    })
  })

  it('passes on the second attempt', async () => {
    const h = harness({ verdicts: ['fail', 'pass'] })
    expect(await runDelivery(WORK, h.deps)).toBe('review')
  })

  it('counts a build with no commit as a failed verify, without running Verify', async () => {
    const h = harness({ commits: [0, 1] })
    expect(await runDelivery(WORK, h.deps)).toBe('review')
    expect(h.handoffs.map((x) => `${x.phase}-${x.attempt}`)).toEqual([
      'plan-1',
      'build-1',
      'build-2',
      'verify-2',
    ])
    expect(h.handoffs[2]?.handoff).toContain('made no commit')
  })

  it.each([
    ['a planner that saved no plan', { plan: 'no-plan' as const }, 'the planner saved no plan'],
    ['a plan phase that failed', { plan: 'fails' as const }, 'the plan phase failed'],
    [
      'a verifier that saved no report',
      { verdicts: ['no-report' as const] },
      'the verifier saved no report',
    ],
    [
      'a push that git refused',
      { push: 'fails' as const },
      'git push -u origin board/PAY-1-r2 failed: rejected',
    ],
  ])('fails the run on %s, saying why', async (_name, script, reason) => {
    const h = harness(script)
    expect(await runDelivery(WORK, h.deps)).toBe('failed')
    expect(h.runEnd()).toMatchObject({ payload: { outcome: 'failed', reason } })
    expect(h.gitCalls.at(-1)).toBe('remove')
  })

  it('ends a cancelled run as cancelled', async () => {
    const h = harness({ cancelIn: 'build' })
    expect(await runDelivery(WORK, h.deps)).toBe('cancelled')
    expect(h.runEnd()).toMatchObject({ payload: { outcome: 'cancelled' } })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run --workspace runner test -- tests/unit/delivery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`runner/src/delivery.ts`:

```ts
import { join } from 'node:path'
import type { BoardApi } from './api.js'
import type { PlanData, ReportData, Work } from './contract.js'
import type { RunnerConfig } from './config.js'
import { GitError, type Git } from './git.js'
import { buildHandoff, type HandoffInput } from './phases/handoff.js'
import type { PhaseDeps, PhaseInput, PhaseResult } from './phases/phase.js'
import { prepareRunDir, writePlanFiles } from './phases/run-dir.js'
import { newEvent, type EventSink } from './sink.js'
import type { runTestCommand } from './test-command.js'

export interface DeliveryDeps {
  api: BoardApi
  git: Git
  sink: EventSink
  setToken(token: string): void
  runPhase: (input: PhaseInput, deps: PhaseDeps) => Promise<PhaseResult>
  runTests: typeof runTestCommand
  config: RunnerConfig
  signal: AbortSignal
}

type Outcome = 'review' | 'failed' | 'cancelled'
const MAX_ATTEMPTS = 3

/** Thrown inside the run to end it; caught once, at the bottom. */
class End extends Error {
  constructor(
    readonly outcome: Outcome,
    readonly reason: string | null,
  ) {
    super(reason ?? outcome)
  }
}

export async function runDelivery(work: Work, deps: DeliveryDeps): Promise<Outcome> {
  const { run } = work
  const { project, task } = run
  const branch = `board/${task.key}-r${run.number}`
  const worktree = join(deps.config.home, 'worktrees', run.id)
  const runDir = join(deps.config.home, 'runs', run.id)
  const common = {
    taskKey: task.key,
    title: task.title,
    specVersion: run.spec.version,
    specMd: run.spec.body_md,
    budgetUsd: task.budget_usd,
  }
  const summaries: HandoffInput['summaries'] = []
  let worktreeReady = false

  const phase = async (
    name: 'plan' | 'build' | 'verify',
    attempt: number,
    extra: Partial<HandoffInput>,
  ): Promise<PhaseResult> => {
    const result = await deps.runPhase(
      {
        runId: run.id,
        phase: name,
        attempt,
        handoff: buildHandoff({
          ...common,
          phase: name,
          attempt,
          summaries: [...summaries],
          ...extra,
        }),
        worktree,
        runDir,
        budgetUsd: task.budget_usd,
      },
      {
        api: deps.api,
        sink: deps.sink,
        claudeBin: deps.config.claudeBin,
        boardUrl: deps.config.boardUrl,
        signal: deps.signal,
        setToken: deps.setToken,
      },
    )
    if (result.cancelled) throw new End('cancelled', 'cancelled by the owner')
    if (!result.ok)
      throw new End(
        'failed',
        attempt === 1 && name !== 'build'
          ? `the ${name} phase failed`
          : `the ${name} phase failed on attempt ${attempt}`,
      )
    summaries.push({ phase: name, attempt, text: result.summary })
    return result
  }

  const artifact = async (kind: 'plan' | 'verify_report', phaseId: string) =>
    (await deps.api.getRun(run.id)).artifacts.find((a) => a.kind === kind && a.phase_id === phaseId)

  let outcome: Outcome = 'failed'
  let extra: Record<string, unknown> = {}
  try {
    deps.setToken(await deps.api.issueToken(run.id))
    if (run.kind !== 'delivery') throw new End('failed', 'spec runs arrive in slice 3')
    prepareRunDir(runDir)
    await deps.git.prepareWorktree(project.repo_path, project.base_branch, branch, worktree)
    worktreeReady = true

    const planned = await phase('plan', 1, {})
    const planArtifact = await artifact('plan', planned.phaseId)
    if (planArtifact === undefined) throw new End('failed', 'the planner saved no plan')
    const plan = planArtifact.data as PlanData
    writePlanFiles(runDir, [...new Set(plan.steps.flatMap((step) => step.files))])

    let failingReport: string | undefined
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await phase('build', attempt, {
        plan: planArtifact.body_md,
        ...(failingReport === undefined ? {} : { verifyReport: failingReport }),
      })
      const commits = await deps.git.newCommits(worktree, project.base_branch)
      const tests = await deps.runTests(project.test_command, worktree, {
        timeoutMs: deps.config.testTimeoutMs,
      })
      await deps.sink.send([
        newEvent(
          { runId: run.id, phaseId: null, type: 'tool_call', agent: 'runner' },
          {
            tool: 'test_command',
            target: project.test_command,
            status: tests.exitCode === 0 ? 'ok' : 'error',
            duration_ms: tests.durationMs,
            payload: {
              exit_code: tests.exitCode,
              timed_out: tests.timedOut,
              truncated: tests.truncated,
              output_tail: tests.output.slice(-4_096),
            },
          },
        ),
      ])
      if (commits === 0) {
        failingReport =
          'The build made no commit, so there was nothing to verify. Commit your work.'
        continue
      }

      const verified = await phase('verify', attempt, {
        plan: planArtifact.body_md,
        testOutput: `exit code: ${tests.timedOut ? 'killed after timeout' : String(tests.exitCode)}\n${tests.truncated ? '[output cut to its end]\n' : ''}${tests.output}`,
        diff: await deps.git.diff(worktree, project.base_branch),
      })
      const reportArtifact = await artifact('verify_report', verified.phaseId)
      if (reportArtifact === undefined) throw new End('failed', 'the verifier saved no report')
      const report = reportArtifact.data as ReportData
      if (report.criteria.every((criterion) => criterion.status === 'pass')) {
        await deps.git.push(worktree, branch)
        const pr = await deps.git.createPr(worktree, {
          githubRepo: project.github_repo,
          base: project.base_branch,
          branch,
          title: `${task.key}: ${task.title}`,
          body: `${task.key}, run ${run.number}, spec v${run.spec.version}.\n\n## Verify report\n\n${reportArtifact.body_md}\n`,
        })
        outcome = 'review'
        extra = { pr_number: pr.number, pr_url: pr.url }
        return outcome
      }
      failingReport = reportArtifact.body_md
    }
    throw new End('failed', 'verify failed three times')
  } catch (error) {
    if (error instanceof End) {
      outcome = error.outcome
      extra = { reason: error.reason }
    } else if (error instanceof GitError) {
      extra = { reason: error.message }
    } else {
      extra = { reason: error instanceof Error ? error.message : String(error) }
    }
    return outcome
  } finally {
    if (worktreeReady)
      await deps.git.removeWorktree(project.repo_path, worktree).catch(() => undefined)
    await deps.sink.send([
      newEvent(
        { runId: run.id, phaseId: null, type: 'run_end' },
        { payload: { outcome, branch, worktree_path: worktree, ...extra } },
      ),
    ])
  }
}
```

`runner/src/daemon.ts`:

```ts
import { join } from 'node:path'
import { BoardApi } from './api.js'
import { loadRunnerConfig, type RunnerConfig } from './config.js'
import { runDelivery } from './delivery.js'
import { realExec } from './exec.js'
import { Git } from './git.js'
import { runPhase } from './phases/phase.js'
import { EventSink } from './sink.js'
import { runTestCommand } from './test-command.js'

const BACKOFF_MS = 5_000

export class Daemon {
  private readonly api: BoardApi
  private readonly git: Git

  constructor(
    private readonly config: RunnerConfig,
    private readonly overrides: Partial<{
      api: BoardApi
      git: Git
      runPhase: typeof runPhase
      runTests: typeof runTestCommand
    }> = {},
  ) {
    this.api = overrides.api ?? new BoardApi(config.boardUrl, config.runnerKey)
    this.git = overrides.git ?? new Git(realExec, config.ghBin)
  }

  /** Claims one run and carries it out. `false` when there was nothing to claim. */
  async runOnce(): Promise<boolean> {
    const work = await this.api.claim(this.config.runnerId, this.config.claimWaitMs)
    if (work === null) return false
    const controller = new AbortController()
    const heartbeat = setInterval(() => {
      this.api
        .heartbeat(this.config.runnerId, [work.run.id])
        .then((cancel) => {
          if (cancel.includes(work.run.id)) controller.abort()
        })
        .catch(() => undefined)
    }, this.config.heartbeatMs)
    let token = ''
    try {
      await runDelivery(work, {
        api: this.api,
        git: this.git,
        sink: new EventSink(
          this.api,
          join(this.config.home, 'runs', work.run.id, 'events.ndjson'),
          () => token,
        ),
        setToken: (next) => {
          token = next
        },
        runPhase: this.overrides.runPhase ?? runPhase,
        runTests: this.overrides.runTests ?? runTestCommand,
        config: this.config,
        signal: controller.signal,
      })
    } finally {
      clearInterval(heartbeat)
    }
    return true
  }

  async loop(stop: AbortSignal): Promise<void> {
    while (!stop.aborted) {
      try {
        await this.runOnce()
      } catch (error) {
        console.error(
          `board-cli: ${error instanceof Error ? error.message : String(error)}; retrying in ${BACKOFF_MS / 1000}s`,
        )
        await new Promise((done) => setTimeout(done, BACKOFF_MS))
      }
    }
  }
}

export async function main(): Promise<void> {
  const config = loadRunnerConfig(process.env)
  const stop = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort())
  console.log(`board-cli: runner ${config.runnerId} claiming from ${config.boardUrl}`)
  await new Daemon(config).loop(stop.signal)
}
```

In `runner/src/cli.ts`, add the `daemon` command and name it in the usage line:

```ts
const [command, ...args] = process.argv.slice(2)
if (command === 'event') await event(args[0] ?? '')
else if (command === 'guard') await guard()
else if (command === 'daemon') {
  const { main } = await import('./daemon.js')
  await main()
} else {
  process.stderr.write(
    'usage: board-cli daemon | event <PostToolUse|SubagentStart|SubagentStop> | guard\n',
  )
  process.exit(2)
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm run --workspace runner test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runner
git commit -m "feat(runner): carry a run from plan to pull request and claim the next"
```

---

### Task 21: The runner against the real server — scenarios with a fake `claude`

**Files:**

- Create: `runner/tests/fake/fake-claude.ts`, `runner/tests/fake/fake-claude`,
  `runner/tests/integration/scenarios.test.ts`
- Modify: `runner/package.json` (dev dependencies)

**Interfaces:**

- Consumes: the server's `buildApp`, `createDb`, `runMigrations` (imported from
  `../../../server/src/…`), the runner's `Daemon`, `targetRepository` and
  `useTestGitIdentity` from `target-repo.ts`.
- Produces: `fake-claude`, driven by a JSON script in `FAKE_CLAUDE_SCRIPT`:
  `{ "<agent>": [[step, …] for the first call, [step, …] for the second, …] }`, steps being
  `{ "tool": "<mcp tool>", "args": {…} }`, `{ "edit": "<path>", "content": "…" }`,
  `{ "commit": "<message>" }`, `{ "sleep": <ms> }`, `{ "exit": <code> }`. After its steps it
  replays `plain.ndjson`, so every call ends in a real `result` with real usage.

- [ ] **Step 1: Dependencies**

```bash
npm install --workspace runner --save-dev @modelcontextprotocol/sdk@^1.32.1 @testcontainers/postgresql@^12.0.4 testcontainers@^12.0.4
```

- [ ] **Step 2: The fake `claude`**

`runner/tests/fake/fake-claude` (then `chmod +x`):

```sh
#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/../../../node_modules/.bin/tsx" "$DIR/fake-claude.ts" "$@"
```

`runner/tests/fake/fake-claude.ts`:

```ts
// Stands in for `claude -p` in the scenario tests. It does what the script tells the named
// agent to do — through the same MCP server and the same hooks a real agent goes through —
// then replays a recorded stream, so usage and the result are real.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

type Step =
  | { tool: string; args: Record<string, unknown> }
  | { edit: string; content: string }
  | { commit: string }
  | { sleep: number }
  | { exit: number }

const args = process.argv.slice(2)
const flag = (name: string) => args[args.indexOf(name) + 1] ?? ''
const agent = flag('--agent')
const sessionId = flag('--session-id')
const settings = JSON.parse(readFileSync(flag('--settings'), 'utf8')) as {
  hooks: Record<string, { hooks: { command: string }[] }[]>
}

const scriptPath = process.env.FAKE_CLAUDE_SCRIPT!
const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as Record<string, Step[][]>
const statePath = `${scriptPath}.calls.json`
const calls = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, number>)
  : {}
const call = calls[agent] ?? 0
writeFileSync(statePath, JSON.stringify({ ...calls, [agent]: call + 1 }))
const steps = script[agent]?.[call] ?? script[agent]?.at(-1) ?? []

function hook(event: string, input: object): string {
  const command = settings.hooks[event]?.[0]?.hooks[0]?.command
  if (command === undefined) return ''
  return spawnSync('sh', ['-c', command], {
    input: JSON.stringify({ cwd: process.cwd(), ...input }),
    encoding: 'utf8',
    env: process.env,
  }).stdout
}

const print = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`)

for (const step of steps) {
  if ('tool' in step) {
    const client = new Client({ name: 'fake-claude', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${process.env.BOARD_URL}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${process.env.BOARD_RUN_TOKEN}` } },
      }),
    )
    const result = await client.callTool({ name: step.tool, arguments: step.args })
    print({
      type: 'system',
      subtype: 'fake_tool',
      tool: step.tool,
      is_error: result.isError === true,
    })
    await client.close()
  } else if ('edit' in step) {
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: step.edit, old_string: '', new_string: step.content },
    }
    if (hook('PreToolUse', input).includes('"deny"')) {
      print({ type: 'system', subtype: 'fake_denied', path: step.edit })
      continue
    }
    mkdirSync(dirname(join(process.cwd(), step.edit)), { recursive: true })
    writeFileSync(join(process.cwd(), step.edit), step.content)
    hook('PostToolUse', { ...input, tool_response: {} })
  } else if ('commit' in step) {
    execFileSync('git', ['add', '-A'])
    execFileSync('git', ['commit', '-q', '-m', step.commit])
  } else if ('sleep' in step) {
    await new Promise((done) => setTimeout(done, step.sleep))
  } else if ('exit' in step) {
    process.exit(step.exit)
  }
}

for (const line of readFileSync(
  join(import.meta.dirname, '../fixtures/stream/plain.ndjson'),
  'utf8',
).split('\n')) {
  if (line === '') continue
  const parsed = JSON.parse(line) as Record<string, unknown>
  if ('session_id' in parsed) parsed.session_id = sessionId
  print(parsed)
}
```

- [ ] **Step 3: Write the failing scenario test**

`runner/tests/integration/scenarios.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { buildApp } from '../../../server/src/app.js'
import { createDb } from '../../../server/src/db/client.js'
import { runMigrations } from '../../../server/src/db/migrate.js'
import type { Database } from '../../../server/src/db/schema.js'
import { Daemon } from '../../src/daemon.js'
import { loadRunnerConfig } from '../../src/config.js'
import { targetRepository, useTestGitIdentity } from './target-repo.js'

const RUNNER_KEY = 'r'.repeat(40)
const FAKE_CLAUDE = join(import.meta.dirname, '../fake/fake-claude')
const FAKE_GH = join(import.meta.dirname, '../fake/fake-gh')
const SPEC = `## Requirements
1. R1 – Retries back off
## Acceptance criteria
- AC1 (R1): Given a failure Then it retries after 1, 2 and 4 seconds
## Open questions
`
const PLAN = {
  summary: 'One step',
  confidence: 'high',
  steps: [{ title: 'Delays', requirements: ['R1'], files: ['src/retry.ts'] }],
  checks: [{ criterion: 'AC1', how: 'read the delays' }],
}
const report = (status: 'pass' | 'fail') => ({
  tool: 'save_report',
  args: { summary: status, criteria: [{ id: 'AC1', status, evidence: 'src/retry.ts' }] },
})

let container: StartedPostgreSqlContainer
let db: Kysely<Database>
let app: FastifyInstance
let base: string
let target: { remote: string; repo: string }

beforeAll(async () => {
  useTestGitIdentity()
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  db = createDb(container.getConnectionUri())
  await runMigrations(db)
  app = await buildApp({
    db,
    config: {
      databaseUrl: container.getConnectionUri(),
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['127.0.0.1', 'localhost'],
      runnerKey: RUNNER_KEY,
      logLevel: 'silent',
      prPollMs: 180_000,
      claimWaitMs: 0,
    },
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
}, 120_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await container?.stop()
})

beforeEach(async () => {
  await sql`truncate table events, phases, artifacts, approval_requests, run_tokens, runs, specs, tasks, projects, prices restart identity cascade`.execute(
    db,
  )
  target = targetRepository()
  await db
    .insertInto('projects')
    .values({
      key: 'PAY',
      name: 'Payments',
      repo_path: target.repo,
      github_repo: 'owner/pay',
      base_branch: 'main',
      test_command: 'test -f src/retry.ts',
    })
    .execute()
})

/** The few response fields these scenarios read. */
interface RunJson {
  id: string
  status: string
  pr_number: number | null
  branch: string | null
  failure_reason: string | null
  fix_loops: number
  current_phase: string | null
  phases: { name: string; status: string }[]
}
interface EventJson {
  type: string
  tool: string | null
  target: string | null
  status: string | null
}
interface CostJson {
  totals: { usage: { input: number } }
  byPhase: unknown[]
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return (await response.json()) as T
}

const runs = (taskId: string) => api<RunJson[]>('GET', `/api/tasks/${taskId}/runs`)

/** A task with an approved spec and a queued run, as the owner leaves it. */
async function approvedTask(): Promise<string> {
  const task = await api<{ id: string }>('POST', '/api/projects/PAY/tasks', {
    title: 'Back off retries',
  })
  const spec = await api<{ id: string }>('POST', `/api/tasks/${task.id}/specs`, { body_md: SPEC })
  await api('POST', `/api/specs/${spec.id}/approve`)
  return task.id
}

function daemon(script: object): Daemon {
  const dir = mkdtempSync(join(tmpdir(), 'scenario-'))
  const scriptPath = join(dir, 'script.json')
  writeFileSync(scriptPath, JSON.stringify(script))
  process.env.FAKE_CLAUDE_SCRIPT = scriptPath
  return new Daemon(
    loadRunnerConfig({
      RUNNER_KEY,
      BOARD_URL: base,
      RUNNER_ID: 'test-runner',
      CLAUDE_BIN: FAKE_CLAUDE,
      GH_BIN: FAKE_GH,
      BOARD_HOME: join(dir, 'home'),
      CLAIM_WAIT_MS: '1',
      HEARTBEAT_MS: '200',
      TEST_TIMEOUT_MS: '60000',
    }),
  )
}

const state = async (taskId: string) =>
  (await api<{ state: string }>('GET', `/api/tasks/${taskId}`)).state

describe('a delivery run end to end', () => {
  it('goes from an approved spec to a pull request, with every step on the card', async () => {
    const taskId = await approvedTask()
    const ran = await daemon({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [
        [
          { edit: 'src/retry.ts', content: 'export const delays = [1, 2, 4]\n' },
          { commit: 'back off' },
        ],
      ],
      verifier: [[report('pass')]],
    }).runOnce()

    expect(ran).toBe(true)
    expect(await state(taskId)).toBe('review')
    const [run] = await runs(taskId)
    expect(run).toMatchObject({ status: 'succeeded', pr_number: 7, branch: 'board/PAY-1-r1' })
    expect(run!.phases.map((p) => `${p.name}:${p.status}`)).toEqual([
      'plan:succeeded',
      'build:succeeded',
      'verify:succeeded',
    ])
    expect(
      execFileSync('git', ['-C', target.remote, 'show', 'board/PAY-1-r1:src/retry.ts'], {
        encoding: 'utf8',
      }),
    ).toContain('[1, 2, 4]')

    const { events } = await api<{ events: EventJson[] }>(
      'GET',
      `/api/runs/${run!.id}/events?limit=1000`,
    )
    expect(
      events.some(
        (e) => e.type === 'tool_call' && e.tool === 'Edit' && e.target === 'src/retry.ts',
      ),
    ).toBe(true)
    expect(events.some((e) => e.tool === 'test_command' && e.status === 'ok')).toBe(true)
    const costs = await api<CostJson>('GET', `/api/tasks/${taskId}/costs`)
    expect(costs.totals.usage.input).toBeGreaterThan(0)
    expect(costs.byPhase).toHaveLength(3)
  })

  it('refuses an edit outside the plan and keeps it out of the branch', async () => {
    const taskId = await approvedTask()
    await daemon({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [
        [
          { edit: 'src/retry.ts', content: 'export const delays = [1, 2, 4]\n' },
          { edit: 'src/unplanned.ts', content: 'export {}\n' },
          { commit: 'back off' },
        ],
      ],
      verifier: [[report('pass')]],
    }).runOnce()
    expect(await state(taskId)).toBe('review')
    const files = execFileSync(
      'git',
      ['-C', target.remote, 'ls-tree', '-r', '--name-only', 'board/PAY-1-r1'],
      { encoding: 'utf8' },
    )
    expect(files).not.toContain('src/unplanned.ts')
  })

  it('fails after three failed verifications, with three builds on the card', async () => {
    const taskId = await approvedTask()
    await daemon({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [
        [{ edit: 'src/retry.ts', content: 'export const delays = [1]\n' }, { commit: 'try 1' }],
        [{ edit: 'src/retry.ts', content: 'export const delays = [1, 2]\n' }, { commit: 'try 2' }],
        [
          { edit: 'src/retry.ts', content: 'export const delays = [1, 2, 3]\n' },
          { commit: 'try 3' },
        ],
      ],
      verifier: [[report('fail')]],
    }).runOnce()
    expect(await state(taskId)).toBe('failed')
    const [run] = await runs(taskId)
    expect(run).toMatchObject({
      status: 'failed',
      failure_reason: 'verify failed three times',
      fix_loops: 2,
    })
  })

  it('stops a run the owner cancels, within a heartbeat', async () => {
    const taskId = await approvedTask()
    const running = daemon({
      planner: [[{ tool: 'save_plan', args: PLAN }]],
      builder: [[{ sleep: 30_000 }]],
      verifier: [[report('pass')]],
    }).runOnce()
    while ((await runs(taskId))[0]?.current_phase !== 'build') {
      await new Promise((done) => setTimeout(done, 100))
    }
    await api('POST', `/api/tasks/${taskId}/actions/cancel`)
    await running
    expect(await state(taskId)).toBe('failed')
    const [run] = await runs(taskId)
    expect(run!.status).toBe('cancelled')
  })
})
```

- [ ] **Step 4: Run it to see it fail, then pass**

Run: `npm run --workspace runner test -- tests/integration/scenarios.test.ts`
Expected before Steps 1–3 are complete: FAIL. With them: PASS, four scenarios. A failure here
with the unit suites passing is drift between `runner/src/contract.ts` and the server: compare
the field the server refused (the 400 body names it) with the contract.

- [ ] **Step 5: Commit**

```bash
git add runner package-lock.json
git commit -m "test(runner): run deliveries against the real server with a fake claude"
```

---

## Phase F — the web app

Logic that can be wrong lives in pure functions with unit tests; components stay thin and are
exercised by the browser journeys in Task 26, which also scan them for accessibility. Every
widget comes from the zellige kit; spec §8, Accessibility, is the contract each task's markup
meets. Two rules hold throughout: no hook is called inside a render function passed to
`Loaded`, and no live region is mounted in the same render as the message written into it.

### Task 22: The web workspace, its client, the live stream, and the Projects page

**Files:**

- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`,
  `web/.oxlintrc.json`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/types.ts`,
  `web/src/api.ts`, `web/src/stream.ts`, `web/src/errors.ts`, `web/src/page.ts`,
  `web/src/Loaded.tsx`, `web/src/styles.css`, `web/src/routes/Projects.tsx`
- Create through `charter init`: `web/.claude/settings.json`
- Modify: `package.json` (workspaces), `run` (dev, test, check), `charter.json`,
  `.claude/settings.json` (plugins), `CLAUDE.md` (the component kit)
- Test: `web/tests/unit/api.test.ts`, `web/tests/unit/stream.test.ts`,
  `web/tests/unit/errors.test.ts`

**Interfaces:**

- Consumes: every `/api` route of Tasks 7–14.
- Produces: `types.ts` (the server's response shapes); `api` with one function per route;
  `ApiError { status; code; details? }`; `keysFor(message: BoardMessage): QueryKey[]` and
  `useBoardStream(client: QueryClient): void`; query keys `['projects']`, `['board', key]`,
  `['task', id]`, `['specs', taskId]`, `['runs', taskId]`, `['events', runId]`, `['costs', taskId]`.
- Produces: `invalidField(error: unknown): string | undefined` and
  `isConflict(error: unknown): boolean` (`errors.ts`); `useDocumentTitle(title)` and
  `usePage(title, id): RefObject<HTMLHeadingElement | null>` (`page.ts`);
  `Loaded<T>({ query, failure, children: (data: T) => ReactNode })`.

- [ ] **Step 1: Workspace files**

`web/package.json`:

```json
{
  "name": "@board/web",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24.0.0"
  },
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.90.2",
    "@zellige/core": "github:AlexeyVanyukevich/zellige-core#v0.1.1",
    "@zellige/react": "github:AlexeyVanyukevich/zellige-react#v0.1.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-router": "^7.9.3"
  },
  "devDependencies": {
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6.1.2",
    "oxlint": "^1.88.0",
    "oxlint-tsgolint": "^7.0.2004",
    "vite": "^8.2.2",
    "vitest": "^4.1.11"
  }
}
```

`oxlint-tsgolint` runs the type-aware rules and follows TypeScript's major version, 7.

`web/tsconfig.json`:

```json
{
  "extends": "charter/stacks/react/tsconfig",
  "compilerOptions": { "types": ["vite/client"] },
  "include": ["src", "tests", "vite.config.ts"]
}
```

`web/.oxlintrc.json` — the paths are filesystem paths, relative to this file:

```json
{
  "extends": [
    "../node_modules/charter/stacks/react/oxlint.json",
    "../node_modules/charter/stacks/vitest/oxlint.json"
  ]
}
```

`web/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // `changeOrigin: false` keeps the browser's Host, so the server's origin check sees the dev
  // server's origin and host agree. Left to its default, every write in development is refused.
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: { '/api': { target: 'http://127.0.0.1:4100', changeOrigin: false } },
  },
  build: { outDir: '../server/public', emptyOutDir: true },
})
```

The server's host check reads `Host: 127.0.0.1:5174` through the proxy, which is allowed; its
origin check compares `Origin: http://127.0.0.1:5174` with that same host, which agrees.

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Task Board</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Record the web workspace's modules, once the directory exists:

```bash
npx --no charter init frontend typescript react vitest playwright --workspace web
```

Expected: `charter.json` gains
`"web": ["frontend", "typescript", "react", "vitest", "playwright"]`; `web/.claude/settings.json`
is written; both it and the root's `.claude/settings.json` turn on
`frontend-design@claude-plugins-official` and `playwright@claude-plugins-official`, which
`need_plugins` installs on each clone.

In the root `CLAUDE.md`, add to the end of "Conventions" — the `frontend` domain reads the
kit's name from here:

```markdown
UI components come from the `@zellige/react` package, on `@zellige/core`'s tokens and CSS. A
widget the kit lacks is added to the kit, in its own repository, never written in `web/`.
```

Root `package.json`: `"workspaces": ["server", "runner", "web"]`. Add `server/public/` to
`.gitignore` (the web build lands there). In `run`, replace `scenario_dev`, `scenario_test` and
the type step of `scenario_check`, add a lint step after it, and add `stop` and the `RUN_STATE`
handling:

```bash
scenario_dev() {
  need_node; need_deps; need_plugins; need_hooks; need_local_env
  start_db
  run_migrations
  export DATABASE_URL="${DATABASE_URL:-$COMPOSE_DB_URL}"

  if [ "${1:-}" = "--bg" ]; then
    mkdir -p "$RUN_STATE"
    npm run --workspace server dev >"$RUN_STATE/server.log" 2>&1 & echo $! >"$RUN_STATE/server.pid"
    npm run --workspace web dev >"$RUN_STATE/web.log" 2>&1 & echo $! >"$RUN_STATE/web.pid"
    npm run --workspace runner daemon >"$RUN_STATE/runner.log" 2>&1 & echo $! >"$RUN_STATE/runner.pid"
    ok "Running in the background"
    note "http://127.0.0.1:5174   logs: ${RUN_STATE}/*.log   stop: ./run stop"
    return
  fi

  ok "Board on http://127.0.0.1:5174"
  note "Ctrl-C stops the server, the web app and the runner"
  trap 'kill 0' EXIT INT TERM
  npm run --workspace server dev 2>&1 | sed "s/^/${DIM}[server]${OFF} /" &
  npm run --workspace web dev 2>&1 | sed "s/^/${DIM}[web]   ${OFF} /" &
  npm run --workspace runner daemon 2>&1 | sed "s/^/${DIM}[runner]${OFF} /" &
  wait
}

scenario_stop() {
  local stopped=0
  for pidfile in "$RUN_STATE"/*.pid; do
    [ -f "$pidfile" ] || continue
    local pid; pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; stopped=1; fi
    rm -f "$pidfile"
  done
  [ "$stopped" = 1 ] && ok "Stopped" || note "Nothing was running in the background"
}

scenario_test() {
  need_node; need_deps; need_plugins; need_hooks; need_docker
  step "Server suite"
  npm run --workspace server test
  step "Runner suite"
  npm run --workspace runner test
  step "Web suite"
  npm run --workspace web test
}
```

```bash
  step "Types"
  ( cd server && npx tsc --noEmit )
  ( cd runner && npx tsc --noEmit )
  ( cd web && npx tsc --noEmit )
  step "Lint"
  ( cd web && npx oxlint --deny-warnings )
```

with `stop)          scenario_stop ;;` in the `case` and `dev` described as
`[--bg]  PostgreSQL, migrations, the server, the web app and the runner` in `usage`. Then
`npm install`, and format the new `package.json` as Task 1 does.

Expected: `ls node_modules/@zellige/react/dist/index.js` finds the file. npm 11 warns that the
binding's `prepare` script is not in `allowScripts`; the git dependency is built when npm
packs it, and the build is there regardless. If it is missing, run
`npm approve-scripts @zellige/react` and install again.

- [ ] **Step 2: Write the failing tests**

`web/tests/unit/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '../../src/api'

afterEach(() => vi.unstubAllGlobals())

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  )
}

describe('api', () => {
  it('returns the parsed body of a success', async () => {
    respond(200, [{ key: 'PAY' }])
    expect(await api.projects()).toEqual([{ key: 'PAY' }])
  })

  it.each([
    [
      400,
      { error: 'validation_error', message: 'm', details: { field: 'key' } },
      'validation_error',
      { field: 'key' },
    ],
    [409, { error: 'conflict', message: 'stale' }, 'conflict', undefined],
    [502, 'not json at all', 'bad_gateway', undefined],
  ])('turns a %s into an ApiError with its code', async (status, body, code, details) => {
    respond(status, body)
    const error = await api.projects().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status, code, details })
  })

  it('reads every page of a run’s events', async () => {
    const pages = [
      { events: [{ id: 'a' }], next: 'c1' },
      { events: [{ id: 'b' }], next: null },
    ]
    const fetchMock = vi.fn(
      async (_url: string) => new Response(JSON.stringify(pages.shift()), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect((await api.events('r')).map((e) => e.id)).toEqual(['a', 'b'])
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('after=c1')
  })
})
```

`web/tests/unit/stream.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { keysFor } from '../../src/stream'

describe('keysFor', () => {
  it.each([
    [
      { topic: 'task.updated', taskId: 't' },
      [['board'], ['task', 't'], ['specs', 't'], ['runs', 't']],
    ],
    [
      { topic: 'run.event', runId: 'r', taskId: 't' },
      [['board'], ['runs', 't'], ['costs', 't'], ['events', 'r']],
    ],
  ] as const)('refreshes what %j changes', (message, keys) => {
    expect(keysFor(message)).toEqual(keys)
  })
})
```

`web/tests/unit/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api'
import { invalidField, isConflict } from '../../src/errors'

const refused = (details?: Record<string, unknown>) =>
  new ApiError(400, 'validation_error', 'm', details)

describe('invalidField', () => {
  it.each([
    ['the field a service check names', refused({ field: 'repo_path' }), 'repo_path'],
    ['the first schema issue’s path', refused({ issues: [{ instancePath: '/key' }] }), 'key'],
    [
      'a required field the schema missed',
      refused({ issues: [{ instancePath: '', params: { missingProperty: 'name' } }] }),
      'name',
    ],
    ['a refusal that names no field', refused(), undefined],
    ['a conflict', new ApiError(409, 'conflict', 'm'), undefined],
    ['anything that is not an ApiError', new Error('network'), undefined],
  ])('finds %s', (_name, error, field) => {
    expect(invalidField(error)).toBe(field)
  })
})

describe('isConflict', () => {
  it.each([
    [new ApiError(409, 'conflict', 'm'), true],
    [refused(), false],
    [new Error('x'), false],
  ])('%#', (error, expected) => {
    expect(isConflict(error)).toBe(expected)
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm run --workspace web test`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the client, the types, the stream and the error reading**

`web/src/types.ts`:

```ts
export type TaskState =
  | 'backlog'
  | 'spec_draft'
  | 'spec_review'
  | 'ready'
  | 'running'
  | 'needs_approval'
  | 'review'
  | 'done'
  | 'blocked'
  | 'failed'

export interface ProjectView {
  id: string
  key: string
  name: string
  repo_path: string
  github_repo: string
  base_branch: string
  test_command: string
}
export interface TaskCard {
  id: string
  key: string
  title: string
  state: TaskState
  position: number
  phase: string | null
  attempt: number | null
  models: string[]
  cost_usd: number
  cost_complete: boolean
  pr_url: string | null
}
export interface TaskView {
  id: string
  key: string
  number: number
  title: string
  description_md: string
  state: TaskState
  position: number
  budget_usd: number | null
  project: { key: string; name: string; github_repo: string }
}
export interface LintFinding {
  code: string
  id?: string
  text?: string
}
export interface SpecView {
  id: string
  version: number
  body_md: string
  status: 'draft' | 'approved' | 'superseded'
  approved_at: string | null
  lint: {
    requirements: string[]
    criteria: { id: string; requirements: string[]; text: string }[]
    open_questions: string[]
    findings: LintFinding[]
    approvable: boolean
  }
}
export interface PhaseView {
  id: string
  name: string
  attempt: number
  agent: string
  model: string
  status: string
  summary_md: string | null
  started_at: string
  ended_at: string | null
}
export interface ArtifactView {
  id: string
  kind: 'plan' | 'verify_report' | 'pr'
  phase_id: string | null
  body_md: string
  uri: string | null
  data: unknown
}
export interface RunView {
  id: string
  number: number
  kind: string
  status: string
  spec_version: number
  current_phase: string | null
  branch: string | null
  pr_number: number | null
  pr_url: string | null
  failure_reason: string | null
  fix_loops: number
  created_at: string
  started_at: string | null
  ended_at: string | null
  phases: PhaseView[]
  artifacts: ArtifactView[]
}
export interface Usage {
  input: number
  output: number
  cache_read: number
  cache_write: number
}
export interface EventView {
  id: string
  phase_id: string | null
  ts: string
  type: string
  agent: string | null
  model: string | null
  tool: string | null
  target: string | null
  status: string | null
  duration_ms: number | null
  usage: Usage
  payload: Record<string, unknown>
}
export interface CostUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
export interface CostLine {
  usage: CostUsage
  usd: number
}
export interface CostSummary {
  totals: CostLine
  byPhase: (CostLine & {
    phaseId: string
    name: string
    attempt: number
    reportedUsd: number | null
    drift: number | null
    flagged: boolean
  })[]
  byAgent: (CostLine & { agent: string })[]
  byModel: (CostLine & { model: string })[]
  cacheHitRatio: number | null
  missingPrices: string[]
}
export interface PlanData {
  summary: string
  confidence: string
  steps: { title: string; requirements: string[]; files: string[]; estimate_usd?: number }[]
  checks: { criterion: string; how: string }[]
}
export interface ReportData {
  summary: string
  criteria: { id: string; status: 'pass' | 'fail'; evidence: string }[]
}
export interface PrFile {
  path: string
  additions: number
  deletions: number
}
```

`web/src/api.ts`:

```ts
import type {
  EventView,
  PrFile,
  ProjectView,
  RunView,
  SpecView,
  TaskCard,
  TaskView,
  CostSummary,
} from './types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const error = (parsed ?? {}) as {
      error?: string
      message?: string
      details?: Record<string, unknown>
    }
    throw new ApiError(
      response.status,
      error.error ?? (response.status === 502 ? 'bad_gateway' : 'http_error'),
      error.message ?? text,
      error.details,
    )
  }
  return parsed as T
}

export const api = {
  projects: () => request<ProjectView[]>('GET', '/api/projects'),
  createProject: (input: Omit<ProjectView, 'id'>) =>
    request<ProjectView>('POST', '/api/projects', input),
  board: (key: string) =>
    request<{ project: ProjectView; tasks: TaskCard[] }>('GET', `/api/projects/${key}/tasks`),
  createTask: (key: string, input: { title: string; description_md?: string }) =>
    request<TaskView>('POST', `/api/projects/${key}/tasks`, input),
  task: (id: string) => request<TaskView>('GET', `/api/tasks/${id}`),
  patchTask: (
    id: string,
    patch: { title?: string; description_md?: string; position?: number; state?: 'done' },
  ) => request<TaskView>('PATCH', `/api/tasks/${id}`, patch),
  action: (id: string, action: 'cancel' | 'rerun') =>
    request<TaskView>('POST', `/api/tasks/${id}/actions/${action}`),
  specs: (taskId: string) => request<SpecView[]>('GET', `/api/tasks/${taskId}/specs`),
  saveSpec: (taskId: string, body_md: string) =>
    request<SpecView>('POST', `/api/tasks/${taskId}/specs`, { body_md }),
  approve: (specId: string) =>
    request<{ spec: SpecView; run_id: string }>('POST', `/api/specs/${specId}/approve`),
  runs: (taskId: string) => request<RunView[]>('GET', `/api/tasks/${taskId}/runs`),
  costs: (taskId: string) => request<CostSummary>('GET', `/api/tasks/${taskId}/costs`),
  prFiles: (runId: string) => request<PrFile[]>('GET', `/api/runs/${runId}/files`),
  async events(runId: string): Promise<EventView[]> {
    const all: EventView[] = []
    let after: string | null = null
    do {
      const query: string = after === null ? '' : `&after=${encodeURIComponent(after)}`
      const page: { events: EventView[]; next: string | null } = await request(
        'GET',
        `/api/runs/${runId}/events?limit=1000${query}`,
      )
      all.push(...page.events)
      after = page.next
    } while (after !== null)
    return all
  },
}
```

`web/src/stream.ts`:

```ts
import { useEffect } from 'react'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

export type BoardMessage =
  { topic: 'task.updated'; taskId: string } | { topic: 'run.event'; runId: string; taskId: string }

/** What a message from the server makes stale. Prefix keys refresh every query under them. */
export function keysFor(message: BoardMessage): QueryKey[] {
  if (message.topic === 'task.updated')
    return [
      ['board'],
      ['task', message.taskId],
      ['specs', message.taskId],
      ['runs', message.taskId],
    ]
  return [['board'], ['runs', message.taskId], ['costs', message.taskId], ['events', message.runId]]
}

export function useBoardStream(client: QueryClient): void {
  useEffect(() => {
    const source = new EventSource('/api/stream')
    const handle = (event: MessageEvent<string>) => {
      for (const queryKey of keysFor(JSON.parse(event.data) as BoardMessage))
        void client.invalidateQueries({ queryKey })
    }
    source.addEventListener('task.updated', handle)
    source.addEventListener('run.event', handle)
    return () => source.close()
  }, [client])
}
```

`web/src/errors.ts`:

```ts
import { ApiError } from './api'

interface SchemaIssue {
  instancePath?: unknown
  params?: { missingProperty?: unknown }
}

/**
 * The field a refusal is about: a service check's `details.field`, else the first schema issue.
 * The page words the problem itself; the server's `message` is for the log, never shown.
 */
export function invalidField(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.code !== 'validation_error') return undefined
  const field = error.details?.field
  if (typeof field === 'string') return field
  const issues = error.details?.issues
  const first = Array.isArray(issues) ? (issues[0] as SchemaIssue | undefined) : undefined
  if (typeof first?.instancePath === 'string' && first.instancePath !== '')
    return first.instancePath.slice(1).split('/')[0]
  const missing = first?.params?.missingProperty
  return typeof missing === 'string' ? missing : undefined
}

/** The request lost a race: what the page showed was stale, and it has been read again. */
export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'conflict'
}
```

- [ ] **Step 5: Run them to see them pass**

Run: `npm run --workspace web test`
Expected: PASS.

- [ ] **Step 6: The shell, the page helpers and the Projects page**

`web/src/main.tsx` — the kit's tokens and components load before the app's layout:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@zellige/core/tokens.css'
import '@zellige/core/zl.css'
import { App } from './App'
import './styles.css'

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1 } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App client={client} />
    </QueryClientProvider>
  </StrictMode>,
)
```

`web/src/App.tsx`:

```tsx
import { BrowserRouter, Link, Route, Routes } from 'react-router'
import type { QueryClient } from '@tanstack/react-query'
import { useBoardStream } from './stream'
import { Projects } from './routes/Projects'

export function App({ client }: { client: QueryClient }) {
  useBoardStream(client)
  return (
    <BrowserRouter>
      <header className="top">
        <Link to="/" className="brand">
          AI Task Board
        </Link>
      </header>
      <Routes>
        <Route path="/" element={<Projects />} />
      </Routes>
    </BrowserRouter>
  )
}
```

The board's route arrives with the board in Task 23, and the card's with the card in Task 24.

`web/src/page.ts`:

```ts
import { useEffect, useRef } from 'react'

const APP = 'AI Task Board'

/** Names the document while mounted, and gives back the name it found when unmounted. */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    if (title === undefined) return undefined
    const before = document.title
    document.title = `${title} · ${APP}`
    return () => {
      document.title = before
    }
  }, [title])
}

let current: string | undefined

/**
 * Names a page and returns the ref for its `h1`, which must render from the first paint with
 * `tabIndex={-1}`. Arriving from another page moves focus to that heading — a client-side route
 * change otherwise leaves it on a link that is gone. The first page loaded keeps the browser's
 * focus, and StrictMode's second run of the effect sees the same id and does nothing.
 */
export function usePage(title: string | undefined, id: string) {
  useDocumentTitle(title)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const arrived = current !== undefined && current !== id
    current = id
    if (arrived) heading.current?.focus()
  }, [id])
  return heading
}
```

`web/src/Loaded.tsx`:

```tsx
import { useRef, type ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { Loading, Trouble } from '@zellige/react'

/**
 * A query's three states in the kit's components. Retry removes its own button, so it moves
 * focus first to this wrapper, which stays. `children` is a render function, not a component:
 * it must call no hook.
 */
export function Loaded<T>({
  query,
  failure,
  children,
}: {
  query: UseQueryResult<T>
  failure: string
  children: (data: T) => ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const retry = () => {
    box.current?.focus()
    void query.refetch()
  }
  return (
    <div ref={box} tabIndex={-1} className="loaded">
      {query.data !== undefined ? (
        children(query.data)
      ) : query.isError ? (
        <Trouble title={failure} onRetry={retry} />
      ) : (
        <Loading />
      )}
    </div>
  )
}
```

`web/src/routes/Projects.tsx`:

```tsx
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Empty, Field, Input, Notice } from '@zellige/react'
import { api } from '../api'
import { invalidField } from '../errors'
import { Loaded } from '../Loaded'
import { usePage } from '../page'
import type { ProjectView } from '../types'

type FieldName = Exclude<keyof ProjectView, 'id'>

/** The page's own words for each field, and for what is wrong when the server refuses it. */
const FIELDS: readonly { name: FieldName; label: string; hint: string; problem: string }[] = [
  {
    name: 'key',
    label: 'Key',
    hint: 'Starts every task key, as in PAY-1.',
    problem: 'Use 2–10 capital letters and digits, starting with a letter, that no project uses.',
  },
  { name: 'name', label: 'Name', hint: 'Shown beside the key.', problem: 'Enter a name.' },
  {
    name: 'repo_path',
    label: 'Repository path',
    hint: 'The absolute path of the repository on this machine.',
    problem: 'There is no git repository at this path, or another project already uses it.',
  },
  {
    name: 'github_repo',
    label: 'GitHub repository',
    hint: 'owner/name, as a remote of that repository points at it.',
    problem: 'No remote of that repository points at this GitHub repository.',
  },
  {
    name: 'base_branch',
    label: 'Base branch',
    hint: 'Pull requests go into this branch.',
    problem: 'Enter the branch pull requests go into.',
  },
  {
    name: 'test_command',
    label: 'Test command',
    hint: 'Runs in the repository after every Build.',
    problem: 'This command does not run in that repository.',
  },
]

const BLANK: Record<FieldName, string> = {
  key: '',
  name: '',
  repo_path: '',
  github_repo: '',
  base_branch: 'main',
  test_command: 'npm test',
}

export function Projects() {
  const heading = usePage('Projects', 'projects')
  const client = useQueryClient()
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const [form, setForm] = useState(BLANK)
  const create = useMutation({
    mutationFn: () => api.createProject(form),
    onSuccess: () => {
      setForm(BLANK)
      return client.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const field = invalidField(create.error)
  const named = FIELDS.some((f) => f.name === field)
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const summary = useRef<HTMLDivElement>(null)

  // A refusal moves focus to the field it names, which now carries the reason, or else to the
  // summary. Both are rendered by the time this runs, so the reason is read with the focus.
  useEffect(() => {
    if (create.error === null) return
    const input = field === undefined ? undefined : inputs.current.get(field)
    if (input) input.focus()
    else summary.current?.focus()
  }, [create.error, field])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    create.mutate()
  }

  return (
    <main className="page">
      <h1 ref={heading} tabIndex={-1}>
        Projects
      </h1>

      <section aria-labelledby="registered">
        <h2 id="registered">Registered repositories</h2>
        <Loaded query={projects} failure="The projects could not be loaded.">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No projects yet">Register a repository below.</Empty>
            ) : (
              <ul className="projects">
                {list.map((project) => (
                  <li key={project.id}>
                    <Link to={`/p/${project.key}`}>
                      {project.key} {project.name}
                    </Link>
                    <span className="muted">{project.github_repo}</span>
                  </li>
                ))}
              </ul>
            )
          }
        </Loaded>
      </section>

      <section aria-labelledby="register">
        <h2 id="register">Register a repository</h2>
        <form className="register" onSubmit={submit}>
          {FIELDS.map((f) => (
            <Field
              key={f.name}
              label={f.label}
              hint={f.hint}
              error={field === f.name ? f.problem : undefined}
            >
              <Input
                name={f.name}
                value={form[f.name]}
                autoComplete="off"
                ref={(node) => {
                  if (node) inputs.current.set(f.name, node)
                  else inputs.current.delete(f.name)
                }}
                onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
              />
            </Field>
          ))}
          <Notice tone="danger" className="announce" ref={summary} tabIndex={-1}>
            {create.isError && !named ? 'The repository could not be registered. Try again.' : ''}
          </Notice>
          <Notice className="announce">
            {create.isSuccess ? `${create.data.key} registered.` : ''}
          </Notice>
          <Button type="submit" variant="primary" busy={create.isPending}>
            Register
          </Button>
        </form>
      </section>
    </main>
  )
}
```

`web/src/styles.css` — layout only; colour, type, controls and the focus indicator are the
kit's:

```css
body {
  margin: 0;
}
.top {
  display: flex;
  align-items: center;
  gap: var(--zl-space-4);
  padding: var(--zl-space-3) var(--zl-space-5);
  border-block-end: 1px solid var(--zl-line);
  background: var(--zl-surface);
}
.brand {
  font-weight: 700;
  color: var(--zl-ink);
}
.page {
  padding: var(--zl-space-5);
  max-inline-size: 60rem;
}
.muted {
  color: var(--zl-ink-soft);
}
.projects {
  list-style: none;
  padding: 0;
}
.projects li {
  display: flex;
  flex-wrap: wrap;
  gap: var(--zl-space-3);
  padding-block: var(--zl-space-2);
  border-block-end: 1px solid var(--zl-line);
}
.register {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: var(--zl-space-3);
}
.register > .zl-notice,
.register > button {
  grid-column: 1 / -1;
  justify-self: start;
}
/* A live region is in the page from the start, so what is written into it is announced. Empty,
   it takes no room. Unlayered, this wins over the kit's layered rules. */
.announce:empty {
  padding: 0;
  border: 0;
}
```

- [ ] **Step 7: Build, lint and check**

Run: `npm run --workspace web build && ./run check`
Expected: the build writes `server/public/index.html`; check ends `✓ Everything is clean`, its
lint step included. A `jsx-a11y` finding is fixed, not silenced.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json run .gitignore charter.json CLAUDE.md \
  .claude/settings.json web
git commit -m "feat(web): register repositories and follow the board's changes live"
```

---

### Task 23: The board

**Files:**

- Create: `web/src/board/columns.ts`, `web/src/board/TaskCardView.tsx`, `web/src/board/board.css`,
  `web/src/routes/Board.tsx`
- Modify: `web/src/App.tsx` (the board's route)
- Test: `web/tests/unit/columns.test.ts`

**Interfaces:**

- Produces: `MAIN_COLUMNS`, `SIDE_COLUMNS`, `LABELS: Record<TaskState, string>`;
  `columns(tasks: TaskCard[]): Record<TaskState, TaskCard[]>`;
  `dropPatch(card: TaskCard, target: TaskState, before: TaskCard | undefined, column: TaskCard[]):
{ position: number } | { state: 'done' } | null`;
  `stepPatch(card: TaskCard, column: TaskCard[], direction: 'up' | 'down'): { position: number } | null`;
  `positionBetween(prev?: number, next?: number): number`; `shortModel(id: string): string`;
  `formatUsd(usd: number): string`; `cardDomId(taskId: string): string`.

- [ ] **Step 1: Write the failing test**

`web/tests/unit/columns.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  columns,
  dropPatch,
  formatUsd,
  positionBetween,
  shortModel,
  stepPatch,
} from '../../src/board/columns'
import type { TaskCard } from '../../src/types'

const card = (id: string, state: TaskCard['state'], position: number): TaskCard => ({
  id,
  key: id,
  title: id,
  state,
  position,
  phase: null,
  attempt: null,
  models: [],
  cost_usd: 0,
  cost_complete: true,
  pr_url: null,
})

describe('columns', () => {
  it('groups cards by state, each column in position order', () => {
    const grouped = columns([
      card('b', 'backlog', 2),
      card('a', 'backlog', 1),
      card('r', 'review', 1),
    ])
    expect(grouped.backlog.map((c) => c.id)).toEqual(['a', 'b'])
    expect(grouped.review.map((c) => c.id)).toEqual(['r'])
    expect(grouped.done).toEqual([])
  })
})

const backlog = [card('a', 'backlog', 1), card('b', 'backlog', 2), card('c', 'backlog', 3)]

describe('dropPatch', () => {
  it.each([
    ['onto the top of its own column', backlog[2]!, 'backlog', backlog[0], { position: 0 }],
    ['between two cards', backlog[2]!, 'backlog', backlog[1], { position: 1.5 }],
    ['to the end of its own column', backlog[0]!, 'backlog', undefined, { position: 4 }],
  ] as const)('reorders a card dropped %s', (_name, moved, target, before, patch) => {
    expect(dropPatch(moved, target, before, backlog)).toEqual(patch)
  })

  it('moves a card from Review to Done', () => {
    expect(dropPatch(card('r', 'review', 1), 'done', undefined, [])).toEqual({ state: 'done' })
  })

  it.each([
    ['Backlog to Ready', 'backlog', 'ready'],
    ['Running to Done', 'running', 'done'],
    ['Review to Backlog', 'review', 'backlog'],
  ] as const)('refuses a drag from %s', (_name, from, to) => {
    expect(dropPatch(card('x', from, 1), to, undefined, [])).toBeNull()
  })
})

// The buttons that stand in for a drag ask for the same positions a drop would.
describe('stepPatch', () => {
  it.each([
    ['the last card up, between the first two', backlog[2]!, 'up', { position: 1.5 }],
    ['the middle card up, above the first', backlog[1]!, 'up', { position: 0 }],
    ['the first card down, between the last two', backlog[0]!, 'down', { position: 2.5 }],
    ['the middle card down, below the last', backlog[1]!, 'down', { position: 4 }],
    ['the first card up', backlog[0]!, 'up', null],
    ['the last card down', backlog[2]!, 'down', null],
  ] as const)('moves %s', (_name, moved, direction, patch) => {
    expect(stepPatch(moved, backlog, direction)).toEqual(patch)
  })
})

describe('formatting', () => {
  it.each([
    ['claude-sonnet-4-5-20250929', 'sonnet'],
    ['claude-haiku-4-5-20251001', 'haiku'],
    ['claude-opus-4-1', 'opus'],
    ['something-else', 'something-else'],
  ])('shortModel(%s) → %s', (id, short) => {
    expect(shortModel(id)).toBe(short)
  })

  it.each([
    [0, '$0.00'],
    [0.004, '<$0.01'],
    [0.84, '$0.84'],
    [12.346, '$12.35'],
  ])('formatUsd(%s) → %s', (usd, text) => {
    expect(formatUsd(usd)).toBe(text)
  })

  it.each([
    [undefined, 1, 0],
    [1, undefined, 2],
    [1, 2, 1.5],
    [undefined, undefined, 1],
  ])('positionBetween(%s, %s) → %s', (prev, next, expected) => {
    expect(positionBetween(prev, next)).toBe(expected)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run --workspace web test -- tests/unit/columns.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`web/src/board/columns.ts`:

```ts
import type { TaskCard, TaskState } from '../types'

export const MAIN_COLUMNS: TaskState[] = [
  'backlog',
  'spec_draft',
  'spec_review',
  'ready',
  'running',
  'needs_approval',
  'review',
  'done',
]
export const SIDE_COLUMNS: TaskState[] = ['blocked', 'failed']

export const LABELS: Record<TaskState, string> = {
  backlog: 'Backlog',
  spec_draft: 'Spec draft',
  spec_review: 'Spec review',
  ready: 'Ready',
  running: 'Running',
  needs_approval: 'Needs approval',
  review: 'Review',
  done: 'Done',
  blocked: 'Blocked',
  failed: 'Failed',
}

export function columns(tasks: TaskCard[]): Record<TaskState, TaskCard[]> {
  const result = Object.fromEntries(
    [...MAIN_COLUMNS, ...SIDE_COLUMNS].map((state) => [state, [] as TaskCard[]]),
  ) as Record<TaskState, TaskCard[]>
  for (const task of tasks) result[task.state].push(task)
  for (const list of Object.values(result)) list.sort((a, b) => a.position - b.position)
  return result
}

export function positionBetween(prev?: number, next?: number): number {
  if (prev === undefined && next === undefined) return 1
  if (prev === undefined) return next! - 1
  if (next === undefined) return prev + 1
  return (prev + next) / 2
}

/**
 * What a drop asks the server for, or `null` when the drop is not a move a person makes by
 * dragging. Reordering within a column is always allowed; the only move between columns is
 * Review → Done (spec §5).
 */
export function dropPatch(
  card: TaskCard,
  target: TaskState,
  before: TaskCard | undefined,
  column: TaskCard[],
): { position: number } | { state: 'done' } | null {
  if (card.state === target) {
    const others = column.filter((c) => c.id !== card.id)
    const index = before === undefined ? others.length : others.findIndex((c) => c.id === before.id)
    return { position: positionBetween(others[index - 1]?.position, others[index]?.position) }
  }
  if (card.state === 'review' && target === 'done') return { state: 'done' }
  return null
}

/**
 * Move up and Move down, the buttons that make a reorder without a drag (WCAG 2.5.7): one place
 * within the card's column, in position order. `null` at the column's end.
 */
export function stepPatch(
  card: TaskCard,
  column: TaskCard[],
  direction: 'up' | 'down',
): { position: number } | null {
  const index = column.findIndex((c) => c.id === card.id)
  if (index === -1) return null
  if (direction === 'up') {
    const above = column[index - 1]
    if (above === undefined) return null
    return { position: positionBetween(column[index - 2]?.position, above.position) }
  }
  const below = column[index + 1]
  if (below === undefined) return null
  return { position: positionBetween(below.position, column[index + 2]?.position) }
}

export function shortModel(id: string): string {
  return /(opus|sonnet|haiku)/.exec(id)?.[1] ?? id
}

export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<$0.01'
  return `$${usd.toFixed(2)}`
}
```

`web/src/board/TaskCardView.tsx`:

```tsx
import { Fragment, type DragEvent } from 'react'
import { Link } from 'react-router'
import { Badge } from '@zellige/react'
import type { TaskCard } from '../types'
import { formatUsd, shortModel } from './columns'

/** The id of a card's link, by which focus finds the card again after it changes columns. */
export const cardDomId = (taskId: string) => `card-${taskId}`

/**
 * A card is one link, named by its key and title first. The spaces between its parts are text,
 * so the accessible name reads as words. Dragging is for the mouse; each move a drag makes is
 * also a button in the card's dialog.
 */
export function TaskCardView({
  card,
  projectKey,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  card: TaskCard
  projectKey: string
  onDragStart: () => void
  onDragOver: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
}) {
  return (
    <Link
      id={cardDomId(card.id)}
      to={`/p/${projectKey}/${card.id}`}
      className="zl-card task-card"
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span className="card-key">{card.key}</span> <span className="card-title">{card.title}</span>{' '}
      <span className="card-meta">
        {card.state === 'running' && card.phase !== null && (
          <>
            <Badge tone="accent">
              {card.phase}
              {card.attempt !== null && card.attempt > 1 ? ` · attempt ${card.attempt}` : ''}
            </Badge>{' '}
          </>
        )}
        {card.models.map((model) => (
          <Fragment key={model}>
            <Badge>{shortModel(model)}</Badge>{' '}
          </Fragment>
        ))}
        {(card.cost_usd > 0 || !card.cost_complete) && (
          <Badge tone="success">
            {formatUsd(card.cost_usd)}
            {!card.cost_complete && (
              <>
                <span aria-hidden="true">+</span>
                <span className="zl-visually-hidden"> or more: a model has no price yet</span>
              </>
            )}
          </Badge>
        )}
      </span>
    </Link>
  )
}
```

`web/src/routes/Board.tsx`:

```tsx
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Outlet, useLocation, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Input, Notice } from '@zellige/react'
import { api } from '../api'
import { columns, dropPatch, LABELS, MAIN_COLUMNS, SIDE_COLUMNS } from '../board/columns'
import { cardDomId, TaskCardView } from '../board/TaskCardView'
import { isConflict } from '../errors'
import { Loaded } from '../Loaded'
import { usePage } from '../page'
import type { TaskCard, TaskState } from '../types'
import '../board/board.css'

const allowDrop = (event: DragEvent) => event.preventDefault()

export function Board() {
  const { key = '' } = useParams()
  const client = useQueryClient()
  const location = useLocation()
  const board = useQuery({ queryKey: ['board', key], queryFn: () => api.board(key) })
  const name = board.data ? `${board.data.project.key} · ${board.data.project.name}` : key
  const heading = usePage(board.data ? name : undefined, `board:${key}`)
  const [dragged, setDragged] = useState<TaskCard | undefined>()
  const [message, setMessage] = useState('')
  const [title, setTitle] = useState('')
  const [titleMissing, setTitleMissing] = useState(false)
  const titleInput = useRef<HTMLInputElement>(null)

  // Closing a card returns focus to its link. The dialog leaves focus on the page instead when
  // the link it came from was replaced — the card changed columns while open — or the card was
  // opened from its address; then the card's current link takes it. This runs after the
  // dialog's own cleanup, so it sees where that left focus.
  const openCard = useRef<string | undefined>(undefined)
  useEffect(() => {
    const open = /^\/p\/[^/]+\/([^/]+)$/.exec(location.pathname)?.[1]
    const lost = document.activeElement === null || document.activeElement === document.body
    if (open === undefined && openCard.current !== undefined && lost)
      document.getElementById(cardDomId(openCard.current))?.focus()
    openCard.current = open
  }, [location.pathname])

  const refresh = () => client.invalidateQueries({ queryKey: ['board', key] })
  const move = useMutation({
    mutationFn: ({
      card,
      body,
    }: {
      card: TaskCard
      body: { position: number } | { state: 'done' }
    }) => api.patchTask(card.id, body),
    onSuccess: (_task, { card, body }) =>
      setMessage('state' in body ? `${card.key} moved to Done.` : `${card.key} moved.`),
    onError: (error) =>
      setMessage(
        isConflict(error)
          ? 'That card moved meanwhile; the board is up to date again.'
          : 'The board could not save that move. Try again.',
      ),
    onSettled: refresh,
  })
  const create = useMutation({
    mutationFn: () => api.createTask(key, { title: title.trim() }),
    onSuccess: (task) => {
      setTitle('')
      setMessage(`${task.key} added to Backlog.`)
      return refresh()
    },
    onError: () => setMessage('The task could not be added. Try again.'),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const missing = title.trim() === ''
    setTitleMissing(missing)
    if (missing) titleInput.current?.focus()
    else create.mutate()
  }

  return (
    <main className="board-page">
      <div className="board-head">
        <h1 ref={heading} tabIndex={-1}>
          {name}
        </h1>
        <form onSubmit={submit} className="new-task">
          <Field label="New task title" error={titleMissing ? 'Enter a title.' : undefined}>
            <Input ref={titleInput} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Button type="submit" busy={create.isPending}>
            Add task
          </Button>
        </form>
      </div>
      <Notice className="announce">{message}</Notice>
      <Loaded query={board} failure="This board could not be loaded.">
        {(data) => {
          const grouped = columns(data.tasks)
          const drop = (target: TaskState, before?: TaskCard) => (event: DragEvent) => {
            event.preventDefault()
            event.stopPropagation()
            if (dragged === undefined) return
            const body = dropPatch(dragged, target, before, grouped[target])
            setDragged(undefined)
            if (body === null)
              setMessage(
                'Only a card in Review can be dragged, to Done. Other moves are buttons on the card.',
              )
            else move.mutate({ card: dragged, body })
          }
          const column = (state: TaskState) => (
            <section key={state} aria-label={LABELS[state]} className="column">
              <h2>
                {LABELS[state]}{' '}
                <span className="count">
                  {grouped[state].length}
                  <span className="zl-visually-hidden">
                    {grouped[state].length === 1 ? ' card' : ' cards'}
                  </span>
                </span>
              </h2>
              {/* A container with no role takes the column's drops: dropping is for the mouse,
                  and Move up, Move down and Mark done make the same moves. A drop on a card
                  lands before it, through the card's own link. */}
              <div className="drop-zone" onDragOver={allowDrop} onDrop={drop(state)}>
                <ol className="cards">
                  {grouped[state].map((card) => (
                    <li key={card.id}>
                      <TaskCardView
                        card={card}
                        projectKey={key}
                        onDragStart={() => setDragged(card)}
                        onDragOver={allowDrop}
                        onDrop={drop(state, card)}
                      />
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          )
          return (
            <>
              <div className="columns">{MAIN_COLUMNS.map(column)}</div>
              <details className="side" open={SIDE_COLUMNS.some((s) => grouped[s].length > 0)}>
                <summary>Blocked and failed</summary>
                <div className="columns">{SIDE_COLUMNS.map(column)}</div>
              </details>
            </>
          )
        }}
      </Loaded>
      <Outlet />
    </main>
  )
}
```

In `web/src/App.tsx`, import `Board` from `./routes/Board` and add, after the projects route:

```tsx
<Route path="/p/:key" element={<Board />} />
```

`web/src/board/board.css`:

```css
.board-page {
  padding: var(--zl-space-4) var(--zl-space-5);
}
.board-head {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  justify-content: space-between;
  gap: var(--zl-space-4);
}
.board-head h1 {
  margin: 0;
  font-size: 1.25rem;
}
.new-task {
  display: flex;
  align-items: end;
  gap: var(--zl-space-2);
}
/* No scrolling box: one with nothing focusable inside fails the keyboard (axe's
   scrollable-region-focusable), so a board wider than the window scrolls the page. */
.columns {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(150px, 1fr);
  gap: var(--zl-space-3);
  padding-block: var(--zl-space-3);
}
.column {
  display: grid;
  align-content: start;
  gap: var(--zl-space-2);
  min-block-size: 160px;
  padding: var(--zl-space-2);
  border-radius: var(--zl-radius);
  background: var(--zl-surface-sunk);
}
.column h2 {
  margin: var(--zl-space-1);
  font-size: var(--zl-text-sm);
  color: var(--zl-ink-soft);
}
.count {
  font-weight: 400;
}
.drop-zone {
  min-block-size: 120px;
}
.cards {
  display: grid;
  gap: var(--zl-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.task-card {
  display: grid;
  gap: var(--zl-space-1);
  color: var(--zl-ink);
  text-decoration: none;
}
.card-key {
  font-size: var(--zl-text-sm);
  color: var(--zl-ink-soft);
}
.card-title {
  font-weight: 600;
}
.card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--zl-space-1);
}
.side summary {
  cursor: pointer;
  color: var(--zl-ink-soft);
}
```

- [ ] **Step 4: Run the test, the lint and the build**

Run: `npm run --workspace web test && (cd web && npx oxlint --deny-warnings) && npm run --workspace web build`
Expected: PASS; no lint finding; the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat(web): show the board and allow only the drags the table allows"
```

---

### Task 24: The card — Spec and Plan tabs, the moves, Cancel and Re-run

**Files:**

- Create: `web/src/card/lint.ts`, `web/src/card/SpecTab.tsx`, `web/src/card/PlanTab.tsx`,
  `web/src/card/CardDrawer.tsx`, `web/src/card/card.css`
- Modify: `web/src/App.tsx` (the card's route)
- Test: `web/tests/unit/lint.test.ts`

**Interfaces:**

- Produces: `lintMessage(finding: LintFinding): string`; `SPEC_TEMPLATE: string`;
  `editable(state: TaskState): boolean`; `plural(n, one, many?): string`;
  `lintSummary(lint): string`; `savedMessage(spec): string`; the dialog at `/p/:key/:taskId`
  with the tabs `spec` and `plan` (Task 25 adds `timeline`, `cost` and `pr`).

- [ ] **Step 1: Write the failing test**

`web/tests/unit/lint.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  editable,
  lintMessage,
  lintSummary,
  plural,
  savedMessage,
  SPEC_TEMPLATE,
} from '../../src/card/lint'

describe('lintMessage', () => {
  it.each([
    [{ code: 'no_requirements' }, 'The spec has no requirements.'],
    [
      { code: 'requirement_without_id', text: 'Users can retry' },
      'This requirement needs an id like R3: “Users can retry”.',
    ],
    [
      { code: 'criterion_without_id', text: 'Given x' },
      'This criterion needs an id like AC3: “Given x”.',
    ],
    [{ code: 'criterion_without_requirement', id: 'AC2' }, 'AC2 names no requirement.'],
    [{ code: 'requirement_without_criterion', id: 'R2' }, 'R2 has no acceptance criterion.'],
    [
      { code: 'unknown_requirement', id: 'AC2', text: 'R9' },
      'AC2 names R9, which is not a requirement.',
    ],
    [{ code: 'duplicate_id', id: 'R1' }, 'R1 is used twice.'],
    [{ code: 'something_new' }, 'something_new'],
  ])('%j', (finding, message) => {
    expect(lintMessage(finding)).toBe(message)
  })
})

describe('editable', () => {
  it.each([
    ['backlog', true],
    ['spec_review', true],
    ['ready', false],
    ['running', false],
    ['review', false],
  ] as const)('a spec in %s can be edited: %s', (state, expected) => {
    expect(editable(state)).toBe(expected)
  })
})

describe('the words for counts and outcomes', () => {
  it.each([
    [1, 'requirement', undefined, '1 requirement'],
    [2, 'requirement', undefined, '2 requirements'],
    [1, 'criterion', 'criteria', '1 criterion'],
    [3, 'criterion', 'criteria', '3 criteria'],
  ] as const)('plural(%s, %s)', (n, one, many, text) => {
    expect(plural(n, one, many)).toBe(text)
  })

  const lint = (approvable: boolean, findings: number, questions: number) => ({
    requirements: ['R1'],
    criteria: [{ id: 'AC1', requirements: ['R1'], text: 't' }],
    findings: Array.from({ length: findings }, () => ({ code: 'duplicate_id', id: 'R1' })),
    open_questions: Array.from({ length: questions }, (_, i) => `q${i}`),
    approvable,
  })

  it('sums up a clean spec', () => {
    expect(lintSummary(lint(true, 0, 0))).toBe('The spec lints clean: 1 requirement, 1 criterion.')
  })

  it.each([
    [lint(true, 0, 0), 'Saved v2. It lints clean and can be approved.'],
    [lint(false, 2, 1), 'Saved v2. It cannot be approved yet: 3 things to fix, listed under Lint.'],
    [lint(false, 0, 1), 'Saved v2. It cannot be approved yet: 1 thing to fix, listed under Lint.'],
  ])('announces a save: %#', (result, message) => {
    expect(savedMessage({ version: 2, lint: result })).toBe(message)
  })
})

it('offers the platform design’s template, which lints clean once filled', () => {
  expect(SPEC_TEMPLATE).toContain('## Requirements')
  expect(SPEC_TEMPLATE).toContain('## Acceptance criteria')
  expect(SPEC_TEMPLATE).toContain('## Open questions')
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run --workspace web test -- tests/unit/lint.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`web/src/card/lint.ts`:

```ts
import type { LintFinding, SpecView, TaskState } from '../types'

export function lintMessage(finding: LintFinding): string {
  switch (finding.code) {
    case 'no_requirements':
      return 'The spec has no requirements.'
    case 'requirement_without_id':
      return `This requirement needs an id like R3: “${finding.text}”.`
    case 'criterion_without_id':
      return `This criterion needs an id like AC3: “${finding.text}”.`
    case 'criterion_without_requirement':
      return `${finding.id} names no requirement.`
    case 'requirement_without_criterion':
      return `${finding.id} has no acceptance criterion.`
    case 'unknown_requirement':
      return `${finding.id} names ${finding.text}, which is not a requirement.`
    case 'duplicate_id':
      return `${finding.id} is used twice.`
    default:
      return finding.code
  }
}

/** Where `save_spec` is allowed (spec §5); everywhere else the spec is frozen or not yet due. */
export function editable(state: TaskState): boolean {
  return state === 'backlog' || state === 'spec_review'
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function lintSummary(lint: SpecView['lint']): string {
  return `The spec lints clean: ${plural(lint.requirements.length, 'requirement')}, ${plural(
    lint.criteria.length,
    'criterion',
    'criteria',
  )}.`
}

/** What the card's status region says once a version is saved. */
export function savedMessage(spec: Pick<SpecView, 'version' | 'lint'>): string {
  if (spec.lint.approvable) return `Saved v${spec.version}. It lints clean and can be approved.`
  const issues = spec.lint.findings.length + spec.lint.open_questions.length
  return `Saved v${spec.version}. It cannot be approved yet: ${plural(issues, 'thing')} to fix, listed under Lint.`
}

export const SPEC_TEMPLATE = `## Goal
One sentence: what changes for whom.

## Context
Links, related tasks, relevant files and modules.

## Requirements
1. R1 – testable statement

## Acceptance criteria
- AC1 (R1): Given … When … Then …

## Out of scope

## Constraints
Tech stack, performance, security, compatibility.

## Open questions
`
```

`web/src/card/SpecTab.tsx`:

```tsx
import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Notice, Select, Textarea } from '@zellige/react'
import { api, ApiError } from '../api'
import { isConflict } from '../errors'
import { Loaded } from '../Loaded'
import type { SpecView, TaskView } from '../types'
import { editable, lintMessage, lintSummary, savedMessage, SPEC_TEMPLATE } from './lint'

export function SpecTab({ task, onFrozen }: { task: TaskView; onFrozen: () => void }) {
  const specs = useQuery({ queryKey: ['specs', task.id], queryFn: () => api.specs(task.id) })
  return (
    <Loaded query={specs} failure="The spec could not be loaded.">
      {(list) => <SpecEditor task={task} specs={list} onFrozen={onFrozen} />}
    </Loaded>
  )
}

function SpecEditor({
  task,
  specs,
  onFrozen,
}: {
  task: TaskView
  specs: SpecView[]
  /** Approving freezes the spec and both buttons go; the card moves focus before they do. */
  onFrozen: () => void
}) {
  const client = useQueryClient()
  const lintId = useId()
  const [selected, setSelected] = useState<string | undefined>()
  const [draft, setDraft] = useState<string | undefined>()
  const [message, setMessage] = useState('')
  const [problem, setProblem] = useState<{ text: string } | undefined>()
  const problemBox = useRef<HTMLDivElement>(null)
  // A new object each time, so the same failure twice still moves focus to the notice.
  useEffect(() => {
    if (problem) problemBox.current?.focus()
  }, [problem])

  const latest = specs[0]
  const shown = specs.find((s) => s.id === selected) ?? latest
  const show = (id: string) => {
    setSelected(id)
    setDraft(undefined)
  }

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['specs', task.id] }),
      client.invalidateQueries({ queryKey: ['task', task.id] }),
      client.invalidateQueries({ queryKey: ['board'] }),
    ])
  const fail = (action: 'save' | 'approve') => (error: unknown) =>
    setProblem({
      text: isConflict(error)
        ? 'This spec changed elsewhere; the latest version is shown.'
        : error instanceof ApiError && error.code === 'validation_error'
          ? action === 'approve'
            ? 'The spec cannot be approved until it lints clean and has no open questions.'
            : 'The spec could not be saved. Check it and try again.'
          : 'That did not work. Try again.',
    })
  const save = useMutation({
    mutationFn: () => api.saveSpec(task.id, draft ?? shown?.body_md ?? SPEC_TEMPLATE),
    onMutate: () => setProblem(undefined),
    onSuccess: (spec) => {
      show(spec.id)
      setMessage(savedMessage(spec))
    },
    onError: fail('save'),
    onSettled: refresh,
  })
  const approve = useMutation({
    mutationFn: (id: string) => api.approve(id),
    onMutate: () => setProblem(undefined),
    onSuccess: onFrozen,
    onError: fail('approve'),
    onSettled: refresh,
  })

  const canEdit = editable(task.state)
  const text = draft ?? shown?.body_md ?? SPEC_TEMPLATE
  const canApprove =
    shown !== undefined &&
    shown.id === latest?.id &&
    shown.status === 'draft' &&
    shown.lint.approvable &&
    draft === undefined

  return (
    <div className="spec-tab">
      {specs.length > 0 && (
        <Field label="Version">
          <Select value={shown?.id} onChange={(e) => show(e.target.value)}>
            {specs.map((s) => (
              <option key={s.id} value={s.id}>
                v{s.version} · {s.status}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field
        label="Spec"
        hint="Markdown. Give each requirement an id such as R1, and each criterion its own id and the requirements it checks: AC1 (R1)."
      >
        <Textarea
          className="spec-text"
          value={text}
          readOnly={!canEdit}
          rows={22}
          onChange={(e) => setDraft(e.target.value)}
        />
      </Field>
      {shown && draft === undefined && (
        <section aria-labelledby={lintId} className="lint">
          <h3 id={lintId}>Lint</h3>
          {shown.lint.approvable ? (
            <p>{lintSummary(shown.lint)}</p>
          ) : (
            <ul>
              {shown.lint.findings.map((f, i) => (
                <li key={i}>{lintMessage(f)}</li>
              ))}
              {shown.lint.open_questions.map((q) => (
                <li key={q}>Open question: {q}</li>
              ))}
            </ul>
          )}
        </section>
      )}
      <Notice className="announce">{message}</Notice>
      <Notice tone="danger" className="announce" ref={problemBox} tabIndex={-1}>
        {problem?.text}
      </Notice>
      {canEdit ? (
        <div className="actions">
          <Button busy={save.isPending} onClick={() => save.mutate()}>
            Save as v{(latest?.version ?? 0) + 1}
          </Button>
          <Button
            variant="primary"
            busy={approve.isPending}
            disabled={!canApprove}
            onClick={() => shown && approve.mutate(shown.id)}
          >
            Approve
          </Button>
          {!canApprove && (
            <span className="muted">
              Approve needs the latest version saved, linting clean, with no open questions.
            </span>
          )}
        </div>
      ) : (
        shown?.status === 'approved' && (
          <p className="muted">Approved v{shown.version}; frozen for its runs.</p>
        )
      )}
    </div>
  )
}
```

`web/src/card/PlanTab.tsx`:

```tsx
import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge, Empty } from '@zellige/react'
import { api } from '../api'
import { formatUsd } from '../board/columns'
import { Loaded } from '../Loaded'
import type { PlanData, TaskView } from '../types'

export function PlanTab({ task }: { task: TaskView }) {
  const runs = useQuery({ queryKey: ['runs', task.id], queryFn: () => api.runs(task.id) })
  const stepsId = useId()
  return (
    <Loaded query={runs} failure="The runs could not be loaded.">
      {(list) => {
        const artifact = list[0]?.artifacts.filter((a) => a.kind === 'plan').at(-1)
        if (artifact === undefined)
          return (
            <Empty title="No plan yet">
              The plan appears here once a run’s Plan phase saves one.
            </Empty>
          )
        const plan = artifact.data as PlanData
        return (
          <div className="plan-tab">
            <p>{plan.summary}</p>
            <p className="muted">Confidence: {plan.confidence}</p>
            <section aria-labelledby={stepsId}>
              <h3 id={stepsId}>Steps</h3>
              <ol>
                {plan.steps.map((step, i) => (
                  <li key={i}>
                    <strong>{step.title}</strong> <Badge>{step.requirements.join(', ')}</Badge>
                    <div className="files">
                      {step.files.map((f) => (
                        <code key={f}>{f}</code>
                      ))}
                    </div>
                    {step.estimate_usd !== undefined && (
                      <span className="muted">est. {formatUsd(step.estimate_usd)}</span>
                    )}
                  </li>
                ))}
              </ol>
            </section>
            <table>
              <caption>Checks</caption>
              <thead>
                <tr>
                  <th scope="col">Criterion</th>
                  <th scope="col">Check</th>
                </tr>
              </thead>
              <tbody>
                {plan.checks.map((c) => (
                  <tr key={c.criterion}>
                    <th scope="row">{c.criterion}</th>
                    <td>{c.how}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }}
    </Loaded>
  )
}
```

`web/src/card/CardDrawer.tsx` — the kit's side Dialog, its Tabs, and the moves a drag would make:

```tsx
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Dialog, Notice, Tabs } from '@zellige/react'
import { api } from '../api'
import { columns, LABELS, stepPatch } from '../board/columns'
import { isConflict } from '../errors'
import { Loaded } from '../Loaded'
import { useDocumentTitle } from '../page'
import type { TaskState, TaskView } from '../types'
import { PlanTab } from './PlanTab'
import { SpecTab } from './SpecTab'
import './card.css'

type Patch = { position: number } | { state: 'done' }

export function CardDrawer() {
  const { key = '', taskId = '' } = useParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const task = useQuery({ queryKey: ['task', taskId], queryFn: () => api.task(taskId) })
  const board = useQuery({ queryKey: ['board', key], queryFn: () => api.board(key) })
  const [tab, setTab] = useState('spec')
  const [message, setMessage] = useState('')
  const [problem, setProblem] = useState<{ text: string } | undefined>()
  const stateLine = useRef<HTMLParagraphElement>(null)
  const problemBox = useRef<HTMLDivElement>(null)
  useDocumentTitle(task.data ? `${task.data.key} ${task.data.title}` : undefined)

  // The page behind a modal dialog is inert, its live region with it, so the card announces its
  // own changes of state — those its buttons made and those the runner made.
  const seen = useRef<TaskState | undefined>(undefined)
  useEffect(() => {
    if (task.data === undefined) return
    if (seen.current !== undefined && seen.current !== task.data.state)
      setMessage(`${task.data.key} is now in ${LABELS[task.data.state]}.`)
    seen.current = task.data.state
  }, [task.data])
  useEffect(() => {
    if (problem) problemBox.current?.focus()
  }, [problem])

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['task', taskId] }),
      client.invalidateQueries({ queryKey: ['board'] }),
    ])
  const fail = (error: unknown) =>
    setProblem({
      text: isConflict(error)
        ? 'This card changed meanwhile; its latest state is shown.'
        : 'That did not work. Try again.',
    })
  // A button that changes the state removes itself; focus moves first to the state line, which
  // names the new state once it arrives.
  const leave = () => stateLine.current?.focus()
  const move = useMutation({
    mutationFn: (body: Patch) => api.patchTask(taskId, body),
    onMutate: () => setProblem(undefined),
    onError: fail,
    onSettled: refresh,
  })
  const act = useMutation({
    mutationFn: (action: 'cancel' | 'rerun') => api.action(taskId, action),
    onMutate: () => setProblem(undefined),
    onSuccess: leave,
    onError: fail,
    onSettled: refresh,
  })

  const step = (direction: 'up' | 'down') => {
    const card = board.data?.tasks.find((c) => c.id === taskId)
    if (board.data === undefined || card === undefined) return
    const where = LABELS[card.state]
    const body = stepPatch(card, columns(board.data.tasks)[card.state], direction)
    if (body === null)
      setMessage(
        `${card.key} is already at the ${direction === 'up' ? 'top' : 'bottom'} of ${where}.`,
      )
    else
      move.mutate(body, {
        onSuccess: () => setMessage(`${card.key} moved ${direction} in ${where}.`),
      })
  }

  const items = (t: TaskView) => [
    { id: 'spec', label: 'Spec', panel: <SpecTab task={t} onFrozen={leave} /> },
    { id: 'plan', label: 'Plan', panel: <PlanTab task={t} /> },
  ]

  return (
    <Dialog
      open
      onClose={() => navigate(`/p/${key}`)}
      title={task.data?.title ?? 'Card'}
      placement="side"
      className="card-dialog"
    >
      <Loaded query={task} failure="This card could not be loaded.">
        {(t) => (
          <div className="card-body">
            <p className="state-line" ref={stateLine} tabIndex={-1}>
              {t.key} · {LABELS[t.state]}
            </p>
            <div className="card-actions">
              <Button busy={move.isPending} onClick={() => step('up')}>
                Move up
              </Button>
              <Button busy={move.isPending} onClick={() => step('down')}>
                Move down
              </Button>
              {t.state === 'review' && (
                <Button onClick={() => move.mutate({ state: 'done' }, { onSuccess: leave })}>
                  Mark done
                </Button>
              )}
              {(t.state === 'ready' || t.state === 'running') && (
                <Button variant="danger" onClick={() => act.mutate('cancel')}>
                  Cancel run
                </Button>
              )}
              {t.state === 'failed' && (
                <Button variant="primary" onClick={() => act.mutate('rerun')}>
                  Re-run
                </Button>
              )}
            </div>
            <Notice className="announce">{message}</Notice>
            <Notice tone="danger" className="announce" ref={problemBox} tabIndex={-1}>
              {problem?.text}
            </Notice>
            <Tabs label={`${t.key} sections`} items={items(t)} value={tab} onChange={setTab} />
          </div>
        )}
      </Loaded>
    </Dialog>
  )
}
```

In `web/src/App.tsx`, import `CardDrawer` from `./card/CardDrawer` and nest the card's route
inside the board's:

```tsx
<Route path="/p/:key" element={<Board />}>
  <Route path=":taskId" element={<CardDrawer />} />
</Route>
```

`web/src/card/card.css`:

```css
/* Wider than the kit's side dialog: the Cost tab's tables need the room. */
.card-dialog.zl-dialog--side {
  inline-size: min(48rem, 100vw);
}
.card-body,
.spec-tab,
.plan-tab {
  display: grid;
  gap: var(--zl-space-3);
}
.state-line {
  margin: 0;
  color: var(--zl-ink-soft);
}
.card-actions,
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--zl-space-2);
}
.spec-text {
  box-sizing: border-box;
  inline-size: 100%;
  font-family: var(--zl-font-mono);
  font-size: var(--zl-text-sm);
}
.lint h3 {
  margin: 0;
  font-size: var(--zl-text);
}
.lint ul {
  margin: var(--zl-space-1) 0 0;
  padding-inline-start: var(--zl-space-5);
}
.files {
  display: flex;
  flex-wrap: wrap;
  gap: var(--zl-space-2);
  margin-block: var(--zl-space-1);
}
table {
  inline-size: 100%;
  border-collapse: collapse;
  font-size: var(--zl-text-sm);
}
caption {
  padding-block: var(--zl-space-2);
  font-weight: 600;
  text-align: start;
}
th,
td {
  padding: var(--zl-space-1) var(--zl-space-2);
  border-block-end: 1px solid var(--zl-line);
  text-align: start;
}
```

- [ ] **Step 4: Run the tests, the lint and the build**

Run: `npm run --workspace web test && (cd web && npx oxlint --deny-warnings) && npm run --workspace web build`
Expected: PASS; no lint finding; the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat(web): write, lint and approve a spec on the card"
```

---

### Task 25: Timeline, Cost and PR tabs, and the PR's files

**Files:**

- Create: `web/src/card/timeline.ts`, `web/src/card/format.ts`, `web/src/card/TimelineTab.tsx`,
  `web/src/card/CostTab.tsx`, `web/src/card/PrTab.tsx`, `server/src/modules/runs/pr-files.ts`
- Modify: `web/src/card/CardDrawer.tsx` (three tabs), `web/src/card/card.css`,
  `server/src/app.ts` (`gh` dependency)
- Test: `web/tests/unit/timeline.test.ts`, `web/tests/unit/format.test.ts`,
  `server/tests/integration/pr-files.test.ts`

**Interfaces:**

- Produces: `timelineModel(phases: PhaseView[], events: EventView[]): { bands: Band[]; loose: EventView[] }`
  with `Band { phase: PhaseView; steps: EventView[]; tokens: number }`; `formatTokens(n): string`,
  `formatDuration(ms): string`, `formatPercent(ratio): string`;
  `GET /api/runs/:id/files` → `PrFile[]` from `gh pr view <n> --repo <r> --json files`
  (`[]` when the run has no PR yet); `AppDeps.gh?: Gh` (default `realGh`).

- [ ] **Step 1: Write the failing tests**

`web/tests/unit/timeline.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { timelineModel } from '../../src/card/timeline'
import type { EventView, PhaseView } from '../../src/types'

const phase = (id: string, name: string, attempt: number, started: string): PhaseView => ({
  id,
  name,
  attempt,
  agent: 'a',
  model: 'm',
  status: 'succeeded',
  summary_md: null,
  started_at: started,
  ended_at: null,
})
const event = (id: string, phaseId: string | null, ts: string, input = 0): EventView => ({
  id,
  phase_id: phaseId,
  ts,
  type: input > 0 ? 'message' : 'tool_call',
  agent: 'a',
  model: null,
  tool: null,
  target: null,
  status: null,
  duration_ms: null,
  usage: { input, output: 0, cache_read: 0, cache_write: 0 },
  payload: {},
})

describe('timelineModel', () => {
  it('puts each event in its phase’s band, phases and steps in time order', () => {
    const phases = [
      phase('b1', 'build', 1, '2026-10-11T10:01:00Z'),
      phase('p1', 'plan', 1, '2026-10-11T10:00:00Z'),
    ]
    const events = [
      event('e2', 'p1', '2026-10-11T10:00:20Z', 100),
      event('e1', 'p1', '2026-10-11T10:00:10Z'),
      event('e3', 'b1', '2026-10-11T10:01:10Z', 50),
      event('t', null, '2026-10-11T10:02:00Z'),
    ]
    const model = timelineModel(phases, events)
    expect(model.bands.map((b) => [b.phase.id, b.steps.map((s) => s.id), b.tokens])).toEqual([
      ['p1', ['e1', 'e2'], 100],
      ['b1', ['e3'], 50],
    ])
    expect(model.loose.map((e) => e.id)).toEqual(['t'])
  })
})
```

`web/tests/unit/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatDuration, formatPercent, formatTokens } from '../../src/card/format'

describe('format', () => {
  it.each([
    [0, '0'],
    [950, '950'],
    [12_345, '12.3k'],
    [2_500_000, '2.5M'],
  ])('formatTokens(%s) → %s', (n, text) => {
    expect(formatTokens(n)).toBe(text)
  })
  it.each([
    [400, '0.4 s'],
    [65_000, '1 min 5 s'],
    [3_600_000, '60 min 0 s'],
  ])('formatDuration(%s) → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })
  it.each([
    [null, '—'],
    [0.4567, '45.7%'],
  ])('formatPercent(%s) → %s', (ratio, text) => {
    expect(formatPercent(ratio)).toBe(text)
  })
})
```

`server/tests/integration/pr-files.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { seedQueuedRun } from './fixtures.js'
import type { Gh } from '../../src/modules/runs/pr-poller.js'

const calls: string[][] = []
const gh: Gh = async (args) => {
  calls.push(args)
  return {
    code: 0,
    stdout: JSON.stringify({ files: [{ path: 'src/retry.ts', additions: 3, deletions: 1 }] }),
    stderr: '',
  }
}

let app: FastifyInstance
beforeAll(async () => {
  app = await buildTestApp({ gh })
})
beforeEach(async () => {
  await resetDb()
  calls.length = 0
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('GET /api/runs/:id/files', () => {
  it('lists the pull request’s files from GitHub', async () => {
    const { runId } = await seedQueuedRun(getTestDb())
    await getTestDb().updateTable('runs').set({ pr_number: 7 }).where('id', '=', runId).execute()
    const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}/files` })
    expect(response.json()).toEqual([{ path: 'src/retry.ts', additions: 3, deletions: 1 }])
    expect(calls).toEqual([['pr', 'view', '7', '--repo', 'owner/pay', '--json', 'files']])
  })

  it('answers an empty list before there is a pull request, without asking GitHub', async () => {
    const { runId } = await seedQueuedRun(getTestDb())
    expect((await app.inject({ method: 'GET', url: `/api/runs/${runId}/files` })).json()).toEqual(
      [],
    )
    expect(calls).toEqual([])
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run --workspace web test -- tests/unit/timeline.test.ts tests/unit/format.test.ts && npm run --workspace server test -- tests/integration/pr-files.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the server route**

`server/src/modules/runs/pr-files.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'
import { NotFoundError } from '../../shared/errors.js'
import { Uuid } from '../../shared/schemas.js'

export function registerPrFiles(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  app.get(
    '/api/runs/:id/files',
    { schema: { params: Type.Object({ id: Uuid }) } },
    async (request) => {
      const run = await app.db
        .selectFrom('runs')
        .innerJoin('tasks', 'tasks.id', 'runs.task_id')
        .innerJoin('projects', 'projects.id', 'tasks.project_id')
        .select(['runs.pr_number', 'projects.github_repo'])
        .where('runs.id', '=', request.params.id)
        .executeTakeFirst()
      if (run === undefined) throw new NotFoundError('No such run')
      if (run.pr_number === null) return []
      const result = await app.gh([
        'pr',
        'view',
        String(run.pr_number),
        '--repo',
        run.github_repo,
        '--json',
        'files',
      ])
      if (result.code !== 0) throw new Error(`gh pr view failed: ${result.stderr}`)
      return (
        JSON.parse(result.stdout) as {
          files: { path: string; additions: number; deletions: number }[]
        }
      ).files
    },
  )
}
```

In `server/src/app.ts`: add `gh?: Gh` to `AppDeps` and `gh: Gh` to the `FastifyInstance`
declaration, decorate `app.decorate('gh', deps.gh ?? realGh)`, and register
`registerPrFiles(app)` after `registerRuns(app)`, importing `realGh, type Gh` from
`./modules/runs/pr-poller.js` and `registerPrFiles` from `./modules/runs/pr-files.js`.

- [ ] **Step 4: Implement the web pieces**

`web/src/card/timeline.ts`:

```ts
import type { EventView, PhaseView } from '../types'

export interface Band {
  phase: PhaseView
  steps: EventView[]
  tokens: number
}

const byTime =
  <T extends { ts?: string; started_at?: string }>(key: (x: T) => string) =>
  (a: T, b: T) =>
    key(a).localeCompare(key(b))

export function timelineModel(
  phases: PhaseView[],
  events: EventView[],
): { bands: Band[]; loose: EventView[] } {
  const sortedEvents = [...events].sort(byTime((e: EventView) => e.ts))
  const bands = [...phases].sort(byTime((p: PhaseView) => p.started_at)).map((phase) => {
    const steps = sortedEvents.filter((e) => e.phase_id === phase.id)
    const tokens = steps.reduce(
      (sum, e) => sum + e.usage.input + e.usage.output + e.usage.cache_read + e.usage.cache_write,
      0,
    )
    return { phase, steps, tokens }
  })
  const known = new Set(phases.map((p) => p.id))
  return { bands, loose: sortedEvents.filter((e) => e.phase_id === null || !known.has(e.phase_id)) }
}
```

`web/src/card/format.ts`:

```ts
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

export function formatPercent(ratio: number | null): string {
  return ratio === null ? '—' : `${(ratio * 100).toFixed(1)}%`
}
```

`web/src/card/TimelineTab.tsx` — each phase a region named by its heading, each step the
platform's `<details>`:

```tsx
import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Empty, Field, Select } from '@zellige/react'
import { api } from '../api'
import { Loaded } from '../Loaded'
import type { EventView, RunView, TaskView } from '../types'
import { formatDuration, formatTokens } from './format'
import { timelineModel, type Band } from './timeline'

const tokensOf = (event: EventView) =>
  event.usage.input + event.usage.output + event.usage.cache_read + event.usage.cache_write

/** A step's line, in words: a failure says so rather than only turning red. */
function stepLabel(event: EventView): string {
  const base =
    event.type === 'tool_call'
      ? `${event.tool ?? 'tool'} ${event.target ?? ''}`.trim()
      : event.type === 'message'
        ? `${event.agent ?? ''} message${event.payload.declared ? `: ${String(event.payload.summary)}` : ''}`.trim()
        : `${event.type.replaceAll('_', ' ')}${event.agent ? ` · ${event.agent}` : ''}`
  return event.status === 'error' ? `${base} · failed` : base
}

function Step({ event }: { event: EventView }) {
  const tokens = tokensOf(event)
  const nested = event.type === 'subagent_start' || event.type === 'subagent_stop'
  return (
    <li className={nested ? 'step step-nested' : 'step'}>
      <details>
        <summary>
          <span>{stepLabel(event)}</span>
          {tokens > 0 && <span className="muted"> · {formatTokens(tokens)} tokens</span>}
          {event.duration_ms !== null && (
            <span className="muted"> · {formatDuration(event.duration_ms)}</span>
          )}
        </summary>
        <div className="step-detail">
          <p className="muted">
            in {event.usage.input} · out {event.usage.output} · cache read {event.usage.cache_read}{' '}
            · cache write {event.usage.cache_write}
          </p>
          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
        </div>
      </details>
    </li>
  )
}

function BandView({ band }: { band: Band }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="band">
      <h3 id={id}>
        {band.phase.name} · attempt {band.phase.attempt} · {band.phase.agent} · {band.phase.status}{' '}
        · {formatTokens(band.tokens)} tokens
      </h3>
      {band.phase.summary_md && <p className="summary">{band.phase.summary_md}</p>}
      <ol>
        {band.steps.map((e) => (
          <Step key={e.id} event={e} />
        ))}
      </ol>
    </section>
  )
}

function RunTimeline({ runs }: { runs: RunView[] }) {
  const [chosen, setChosen] = useState<string | undefined>()
  const looseId = useId()
  const run = runs.find((r) => r.id === chosen) ?? runs[0]!
  const events = useQuery({ queryKey: ['events', run.id], queryFn: () => api.events(run.id) })
  return (
    <div className="timeline">
      {runs.length > 1 && (
        <Field label="Run">
          <Select value={run.id} onChange={(e) => setChosen(e.target.value)}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                Run {r.number} · {r.status}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {run.failure_reason && (
        <p className="failure">
          <strong>Failed:</strong> {run.failure_reason}
        </p>
      )}
      <Loaded query={events} failure="The run’s steps could not be loaded.">
        {(list) => {
          const model = timelineModel(run.phases, list)
          return (
            <>
              {model.bands.map((band) => (
                <BandView key={band.phase.id} band={band} />
              ))}
              {model.loose.length > 0 && (
                <section aria-labelledby={looseId} className="band">
                  <h3 id={looseId}>Runner</h3>
                  <ol>
                    {model.loose.map((e) => (
                      <Step key={e.id} event={e} />
                    ))}
                  </ol>
                </section>
              )}
            </>
          )
        }}
      </Loaded>
    </div>
  )
}

export function TimelineTab({ task }: { task: TaskView }) {
  const runs = useQuery({ queryKey: ['runs', task.id], queryFn: () => api.runs(task.id) })
  return (
    <Loaded query={runs} failure="The runs could not be loaded.">
      {(list) =>
        list.length === 0 ? (
          <Empty title="No run yet">A run starts when the spec is approved.</Empty>
        ) : (
          <RunTimeline runs={list} />
        )
      }
    </Loaded>
  )
}
```

`web/src/card/CostTab.tsx` — every table captioned, with column and row headers:

```tsx
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@zellige/react'
import { api } from '../api'
import { formatUsd } from '../board/columns'
import { Loaded } from '../Loaded'
import type { CostLine, PlanData, TaskView } from '../types'
import { formatPercent, formatTokens } from './format'

function Cells({ line }: { line: CostLine }) {
  return (
    <>
      <td>{formatTokens(line.usage.input)}</td>
      <td>{formatTokens(line.usage.output)}</td>
      <td>{formatTokens(line.usage.cacheRead)}</td>
      <td>{formatTokens(line.usage.cacheWrite)}</td>
      <td>{formatUsd(line.usd)}</td>
    </>
  )
}
const HEAD = (
  <>
    <th scope="col">In</th>
    <th scope="col">Out</th>
    <th scope="col">Cache read</th>
    <th scope="col">Cache write</th>
    <th scope="col">USD</th>
  </>
)

export function CostTab({ task }: { task: TaskView }) {
  const costs = useQuery({ queryKey: ['costs', task.id], queryFn: () => api.costs(task.id) })
  const runs = useQuery({ queryKey: ['runs', task.id], queryFn: () => api.runs(task.id) })
  return (
    <Loaded query={costs} failure="The costs could not be loaded.">
      {(c) => {
        const plan = runs.data?.[0]?.artifacts.filter((a) => a.kind === 'plan').at(-1)?.data as
          PlanData | undefined
        const estimate = plan?.steps.reduce((sum, s) => sum + (s.estimate_usd ?? 0), 0)
        return (
          <div className="cost-tab">
            <p className="total">
              <strong>Total {formatUsd(c.totals.usd)}</strong> · cache hit ratio{' '}
              {formatPercent(c.cacheHitRatio)}
              {estimate !== undefined && estimate > 0 && (
                <> · plan estimate {formatUsd(estimate)}</>
              )}
            </p>
            {c.missingPrices.length > 0 && (
              <p>
                No price for {c.missingPrices.join(', ')}; their tokens count as $0. Add one with{' '}
                <code>./run price:set &lt;model&gt; …</code>
              </p>
            )}
            <table>
              <caption>By phase</caption>
              <thead>
                <tr>
                  <th scope="col">Phase</th>
                  {HEAD}
                  <th scope="col">Claude Code says</th>
                </tr>
              </thead>
              <tbody>
                {c.byPhase.map((p) => (
                  <tr key={p.phaseId}>
                    <th scope="row">
                      {p.name} {p.attempt}
                    </th>
                    <Cells line={p} />
                    <td>
                      {p.reportedUsd === null ? '—' : formatUsd(p.reportedUsd)}
                      {p.flagged && (
                        <>
                          {' '}
                          <Badge tone="warning">off by {formatPercent(p.drift)}</Badge>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table>
              <caption>By agent</caption>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  {HEAD}
                </tr>
              </thead>
              <tbody>
                {c.byAgent.map((a) => (
                  <tr key={a.agent}>
                    <th scope="row">{a.agent}</th>
                    <Cells line={a} />
                  </tr>
                ))}
              </tbody>
            </table>
            <table>
              <caption>By model</caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  {HEAD}
                </tr>
              </thead>
              <tbody>
                {c.byModel.map((m) => (
                  <tr key={m.model}>
                    <th scope="row">{m.model}</th>
                    <Cells line={m} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }}
    </Loaded>
  )
}
```

`web/src/card/PrTab.tsx`:

```tsx
import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge, Empty, Loading } from '@zellige/react'
import { api } from '../api'
import { Loaded } from '../Loaded'
import type { ReportData, TaskView } from '../types'

export function PrTab({ task }: { task: TaskView }) {
  const runs = useQuery({ queryKey: ['runs', task.id], queryFn: () => api.runs(task.id) })
  const run = runs.data?.[0]
  const files = useQuery({
    queryKey: ['pr-files', run?.id],
    queryFn: () => api.prFiles(run!.id),
    enabled: run?.pr_number != null,
  })
  const filesId = useId()
  return (
    <Loaded query={runs} failure="The runs could not be loaded.">
      {(list) => {
        const latest = list[0]
        if (latest === undefined || latest.pr_url === null)
          return <Empty title="No pull request yet">One opens when every criterion passes.</Empty>
        const report = latest.artifacts.filter((a) => a.kind === 'verify_report').at(-1)?.data as
          ReportData | undefined
        return (
          <div className="pr-tab">
            <p>
              <a href={latest.pr_url} target="_blank" rel="noreferrer">
                Pull request #{latest.pr_number}
                <span className="zl-visually-hidden"> (opens in a new tab)</span>
              </a>{' '}
              on <code>{latest.branch}</code> ·{' '}
              {task.state === 'done' ? 'merged' : task.state === 'failed' ? 'closed' : 'open'}
            </p>
            <section aria-labelledby={filesId}>
              <h3 id={filesId}>Files changed</h3>
              {files.isError ? (
                <p>GitHub did not list the files; they are on the pull request.</p>
              ) : files.data === undefined ? (
                <Loading />
              ) : (
                <ul>
                  {files.data.map((f) => (
                    <li key={f.path}>
                      <code>{f.path}</code> <Badge tone="success">+{f.additions}</Badge>{' '}
                      <Badge tone="danger">−{f.deletions}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {report && (
              <table>
                <caption>Verify report</caption>
                <thead>
                  <tr>
                    <th scope="col">Criterion</th>
                    <th scope="col">Verdict</th>
                    <th scope="col">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {report.criteria.map((c) => (
                    <tr key={c.id}>
                      <th scope="row">{c.id}</th>
                      <td>
                        <Badge tone={c.status === 'pass' ? 'success' : 'danger'}>{c.status}</Badge>
                      </td>
                      <td>{c.evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      }}
    </Loaded>
  )
}
```

In `web/src/card/CardDrawer.tsx`, import the three tabs and extend `items`:

```tsx
import { TimelineTab } from './TimelineTab'
import { CostTab } from './CostTab'
import { PrTab } from './PrTab'
```

```tsx
const items = (t: TaskView) => [
  { id: 'spec', label: 'Spec', panel: <SpecTab task={t} onFrozen={leave} /> },
  { id: 'plan', label: 'Plan', panel: <PlanTab task={t} /> },
  { id: 'timeline', label: 'Timeline', panel: <TimelineTab task={t} /> },
  { id: 'cost', label: 'Cost', panel: <CostTab task={t} /> },
  { id: 'pr', label: 'PR', panel: <PrTab task={t} /> },
]
```

Add to `web/src/card/card.css`:

```css
.timeline,
.cost-tab,
.pr-tab {
  display: grid;
  gap: var(--zl-space-3);
}
.band {
  padding: var(--zl-space-2) var(--zl-space-3);
  border: 1px solid var(--zl-line);
  border-radius: var(--zl-radius);
}
.band h3 {
  margin: 0 0 var(--zl-space-2);
  font-size: var(--zl-text);
}
.band ol {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
/* The summary keeps its own display, and with it the disclosure triangle. */
.step summary {
  padding: 2px var(--zl-space-1);
  cursor: pointer;
}
.step-nested summary {
  padding-inline-start: var(--zl-space-5);
}
/* Wrapped, not scrolled: a scrolling box with nothing focusable inside fails the keyboard. */
.step-detail pre {
  padding: var(--zl-space-2);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  font-size: var(--zl-text-sm);
  background: var(--zl-surface-sunk);
}
.summary {
  color: var(--zl-ink-soft);
}
.failure {
  margin: 0;
}
```

- [ ] **Step 5: Run everything to see it pass**

Run: `npm run --workspace web test && (cd web && npx oxlint --deny-warnings) && npm run --workspace web build && npm run --workspace server test`
Expected: PASS; no lint finding; the build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web server
git commit -m "feat(web): show a run's timeline, costs and pull request on the card"
```

---

## Phase G — the whole product, and closing the slice

### Task 26: The browser journeys — from a registered repository to a pull request, and by keyboard

**Files:**

- Create: `playwright.config.ts`, `tests/ui/global-setup.ts`, `tests/ui/helpers.ts`,
  `tests/ui/task-to-pr.spec.ts`, `tests/ui/keyboard.spec.ts`
- Modify: `package.json` (dev dependencies), `run` (`test:ui`), `charter.json` (the root's
  modules), `.gitignore`

**Interfaces:**

- Consumes: the built web app, the server started as in production, the runner daemon started
  as `./run dev` starts it, with `fake-claude` and `fake-gh` from Tasks 19 and 21.
- Produces: `./run test:ui`; `tests/ui/.runtime.json` (written by the global setup:
  `{ baseURL, repoPath, opsPath }`); `WCAG_TAGS`, `expectAccessible(page)` and
  `tabTo(page, target)` in `tests/ui/helpers.ts`.

Each target repository has two remotes: `origin`, a local bare repository the runner fetches
from and pushes to, and `github`, `git@github.com:owner/<name>.git`, which is never contacted
and exists so the registration check — a remote pointing at the GitHub repository — passes
exactly as it does for a real one. The delivery journey registers `pay`; the keyboard journey
registers `ops` and never approves a spec, so the fake `claude`'s one scripted run stays the
delivery journey's.

- [ ] **Step 1: Dependencies, the root's modules and the scenario**

```bash
npm install --save-dev @playwright/test@^1.62.1 @axe-core/playwright@^4.14.0 \
  @testcontainers/postgresql@^12.0.4 pg@^8.22.0 @types/pg@^8.20.0
npx playwright install chromium
npx --no charter init frontend playwright
```

Expected: `charter.json` gains `".": ["frontend", "playwright"]`, so the journey rules load on
`tests/ui/`.

Add `.runtime.json` under `tests/ui/` to `.gitignore`. In `run`:

```bash
scenario_test_ui() {
  need_node; need_deps; need_plugins; need_hooks; need_docker
  step "The browser journeys against the whole product"
  npx playwright test
}
```

with `test:ui)      scenario_test_ui ;;` in the `case` and
`${BOLD}test:ui${OFF}    the browser journeys, with a fake claude` in `usage`.

- [ ] **Step 2: Configuration, global setup and helpers**

`playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/ui/global-setup.ts',
  // One database, one server, one runner: the journeys share them.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
})
```

`tests/ui/global-setup.ts`:

```ts
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
const SCRIPT = {
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
    JSON.stringify({ baseURL: `http://127.0.0.1:${PORT}`, repoPath, opsPath }),
  )

  return async () => {
    runner.kill('SIGTERM')
    server.kill('SIGTERM')
    await db.stop()
  }
}
```

`tests/ui/helpers.ts`:

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Locator, type Page } from '@playwright/test'

interface Runtime {
  baseURL: string
  repoPath: string
  opsPath: string
}

let cached: Runtime | undefined

export function runtime(): Runtime {
  cached ??= JSON.parse(
    readFileSync(resolve(import.meta.dirname, '.runtime.json'), 'utf8'),
  ) as Runtime
  return cached
}

export const appUrl = (path: string) => `${runtime().baseURL}${path}`

/** WCAG 2.2 AA, as the kit's journey rule names it: one list for every scan. */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

/** Scans the page as it stands; any violation fails the journey. */
export async function expectAccessible(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  expect(violations).toEqual([])
}

/** Presses Tab until `target` has focus, as a keyboard user would; fails after `limit` presses. */
export async function tabTo(page: Page, target: Locator, limit = 40): Promise<void> {
  for (let press = 0; press < limit; press++) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}

/** True when focus is inside the open dialog. */
export const focusInDialog = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest('dialog[open]') != null)

/** The text of whatever has focus — for an element with no role, as the card's state line. */
export const focusedText = (page: Page) =>
  page.evaluate(() => document.activeElement?.textContent?.trim())

export const SPEC = `## Goal
Failed deliveries back off.

## Requirements
1. R1 – Retries back off

## Acceptance criteria
- AC1 (R1): Given a failure Then it retries after 1, 2 and 4 seconds

## Open questions
`
```

- [ ] **Step 3: Write the journeys**

`tests/ui/task-to-pr.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import { appUrl, expectAccessible, focusedText, runtime, SPEC } from './helpers'

test('a task goes from the board to a pull request, with its steps and costs on the card', async ({
  page,
}) => {
  await page.goto(appUrl('/'))
  await expect(page).toHaveTitle('Projects · AI Task Board')
  await expectAccessible(page)

  const fields: [string, string][] = [
    ['Key', 'PAY'],
    ['Name', 'Payments'],
    ['Repository path', runtime().repoPath],
    ['GitHub repository', 'owner/pay'],
    ['Base branch', 'main'],
    ['Test command', 'test -f src/retry.ts'],
  ]
  for (const [name, value] of fields)
    await page.getByRole('textbox', { name, exact: true }).fill(value)
  await page.getByRole('button', { name: 'Register' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'PAY registered.' })).toBeVisible()
  await expectAccessible(page)

  await page.getByRole('link', { name: 'PAY Payments' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'PAY · Payments' })).toBeFocused()
  await page.getByRole('textbox', { name: 'New task title' }).fill('Back off retries')
  await page.getByRole('button', { name: 'Add task' }).click()
  const backlog = page.getByRole('region', { name: 'Backlog' })
  await expect(backlog.getByRole('link', { name: /^PAY-1 Back off retries/ })).toBeVisible()
  await expectAccessible(page)

  await backlog.getByRole('link', { name: /^PAY-1 / }).click()
  const card = page.getByRole('dialog', { name: 'Back off retries' })
  await expect(card).toBeVisible()
  await expect(page).toHaveTitle('PAY-1 Back off retries · AI Task Board')
  await expectAccessible(page)

  await card.getByRole('textbox', { name: 'Spec' }).fill(SPEC)
  await card.getByRole('button', { name: 'Save as v1' }).click()
  await expect(
    card.getByRole('status').filter({ hasText: 'Saved v1. It lints clean and can be approved.' }),
  ).toBeVisible()
  await expect(card.getByRole('region', { name: 'Lint' })).toContainText(
    'The spec lints clean: 1 requirement, 1 criterion.',
  )
  await card.getByRole('button', { name: 'Approve' }).click()

  // The runner claims it, runs three phases with the fake claude, pushes and opens the PR; the
  // open card hears of each move over the event stream, with no reload, and says so.
  await expect(card.getByRole('status').filter({ hasText: 'PAY-1 is now in Review.' })).toBeVisible(
    { timeout: 90_000 },
  )

  await card.getByRole('tab', { name: 'Timeline' }).click()
  const timeline = card.getByRole('tabpanel', { name: 'Timeline' })
  for (const phase of ['plan', 'build', 'verify'])
    await expect(
      timeline.getByRole('region', { name: new RegExp(`^${phase} · attempt 1`) }),
    ).toBeVisible()
  await expect(timeline).toContainText('Edit src/retry.ts')
  await expectAccessible(page)

  await card.getByRole('tab', { name: 'Cost' }).click()
  await expect(card.getByRole('tabpanel', { name: 'Cost' })).toContainText('Total $')
  await expectAccessible(page)

  await card.getByRole('tab', { name: 'PR' }).click()
  const pr = card.getByRole('tabpanel', { name: 'PR' })
  await expect(pr.getByRole('link', { name: /^Pull request #7/ })).toBeVisible()
  await expect(pr.getByRole('table', { name: 'Verify report' })).toContainText('pass')
  await expectAccessible(page)

  // Mark done stands in for the drag to Done, and hands focus to the state line as it goes.
  await card.getByRole('button', { name: 'Mark done' }).click()
  await expect.poll(() => focusedText(page)).toBe('PAY-1 · Done')
  await expect(card.getByRole('status').filter({ hasText: 'PAY-1 is now in Done.' })).toBeVisible()

  // The card left Backlog while it was open; closing hands focus to its link in Done.
  await card.getByRole('button', { name: 'Close' }).click()
  await expect(
    page.getByRole('region', { name: 'Done' }).getByRole('link', { name: /^PAY-1 / }),
  ).toBeFocused()
  await expectAccessible(page)
})

test('a drag the table does not allow is refused with a reason, and nothing moves', async ({
  page,
}) => {
  await page.goto(appUrl('/p/PAY'))
  await page.getByRole('textbox', { name: 'New task title' }).fill('Something else')
  await page.getByRole('button', { name: 'Add task' }).click()
  const card = page.getByRole('region', { name: 'Backlog' }).getByRole('link', { name: /^PAY-2 / })
  await card.dragTo(page.getByRole('region', { name: 'Ready' }))
  await expect(
    page.getByRole('status').filter({ hasText: 'Only a card in Review can be dragged' }),
  ).toBeVisible()
  await expect(card).toBeVisible()
  await expectAccessible(page)
})
```

`tests/ui/keyboard.spec.ts` — one journey, the keyboard alone, asserting where focus lands
after each step that moves it:

```ts
import { expect, test } from '@playwright/test'
import { appUrl, expectAccessible, focusInDialog, runtime, SPEC, tabTo } from './helpers'

test('a repository, the board and a card work from the keyboard alone', async ({ page }) => {
  await page.goto(appUrl('/'))
  const key = page.getByRole('textbox', { name: 'Key', exact: true })
  await tabTo(page, key)

  // Fill the form field by field; the key is lower case, which the schema refuses.
  await page.keyboard.type('ops')
  for (const value of ['Ops', runtime().opsPath, 'owner/ops', 'main', 'test -f src/retry.ts']) {
    await page.keyboard.press('Tab')
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(value)
  }
  await page.keyboard.press('Enter')

  // The refusal hands focus back to the field it names, which now says why.
  await expect(key).toBeFocused()
  await expect(key).toHaveAttribute('aria-invalid', 'true')
  await expect(key).toHaveAccessibleDescription(/capital letters/)
  await expectAccessible(page)

  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('OPS')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'OPS registered.' })).toBeVisible()

  await tabTo(page, page.getByRole('link', { name: 'OPS Ops' }))
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: 'OPS · Ops' })).toBeFocused()

  const title = page.getByRole('textbox', { name: 'New task title' })
  await tabTo(page, title)
  for (const [name, n] of [
    ['First', 1],
    ['Second', 2],
  ] as const) {
    await page.keyboard.type(name)
    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('status').filter({ hasText: `OPS-${n} added to Backlog.` }),
    ).toBeVisible()
    await expect(title).toBeFocused()
    await expect(title).toHaveValue('')
  }

  const backlog = page.getByRole('region', { name: 'Backlog' })
  await tabTo(page, backlog.getByRole('link', { name: /^OPS-2 / }))
  await page.keyboard.press('Enter')
  const card = page.getByRole('dialog', { name: 'Second' })
  await expect(card).toBeVisible()
  expect(await focusInDialog(page)).toBe(true)
  await expectAccessible(page)

  // Move up stands in for the drag that reorders a column.
  await tabTo(page, card.getByRole('button', { name: 'Move up' }))
  await page.keyboard.press('Enter')
  await expect(
    card.getByRole('status').filter({ hasText: 'OPS-2 moved up in Backlog.' }),
  ).toBeVisible()

  // Arrow keys move between tabs; Tab moves on into the panel.
  const specTab = card.getByRole('tab', { name: 'Spec' })
  await tabTo(page, specTab)
  await page.keyboard.press('ArrowRight')
  await expect(card.getByRole('tab', { name: 'Plan' })).toBeFocused()
  await expect(card.getByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(specTab).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(card.getByRole('textbox', { name: 'Spec' })).toBeFocused()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(SPEC)
  await tabTo(page, card.getByRole('button', { name: 'Save as v1' }))
  await page.keyboard.press('Enter')
  await expect(
    card.getByRole('status').filter({ hasText: 'Saved v1. It lints clean and can be approved.' }),
  ).toBeVisible()
  await expectAccessible(page)

  // Escape closes the card and hands focus back to the link that opened it, now first in Backlog.
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
  await expect(backlog.getByRole('link', { name: /^OPS-2 / })).toBeFocused()
  await expect(backlog.getByRole('link')).toHaveText([/^OPS-2 /, /^OPS-1 /])
})
```

The PR tab's file list asks the real `gh` for `owner/pay#7`, which does not exist; the tab says
GitHub did not list the files, and no journey depends on it. The server test in Task 25 covers
the list itself.

- [ ] **Step 4: Run them**

Run: `./run test:ui`
Expected: 3 passed. A failure at "is now in Review" with the server and runner logs above it:
read the `[runner]` lines first — a refused event names the field that drifted. An axe failure
prints each violation's rule, nodes and help URL; fix the markup, and exclude one selector with
a backlog entry only for a failure that cannot be fixed here.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts tests/ui package.json package-lock.json run .gitignore \
  charter.json .claude/settings.json
git commit -m "test(ui): carry a task from the board to a pull request in a browser"
```

---

### Task 27: The smoke run, the documentation, and closing the slice

**Files:**

- Create: `runner/scripts/smoke.ts`, `docs/architecture.md`
- Modify: `run` (`smoke`), `README.md`, `docs/backlog.md`,
  `docs/superpowers/specs/2026-10-10-mvp-design.md` (status line only)
- Move: this plan to `docs/superpowers/plans/archive/`

**Interfaces:**

- Consumes: a running `./run dev --bg`, the real `claude` and `gh`, a throwaway GitHub
  repository the owner names in `SMOKE_REPO_PATH` and `SMOKE_GITHUB_REPO`.
- Produces: `./run smoke`, `docs/architecture.md`.

- [ ] **Step 1: The smoke script**

`runner/scripts/smoke.ts`:

```ts
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
```

In `run`:

```bash
# Real claude, real gh, real tokens — never part of `check`. The target is a throwaway GitHub
# repository the owner created for this, cloned locally, with `main` pushed.
scenario_smoke() {
  need_node; need_deps; need_plugins; need_hooks; need_local_env
  [ -n "${SMOKE_REPO_PATH:-}" ] && [ -n "${SMOKE_GITHUB_REPO:-}" ] ||
    die "SMOKE_REPO_PATH and SMOKE_GITHUB_REPO are not set." \
      "Create a throwaway GitHub repository, clone it, and set both in .env — see the README."
  command -v claude >/dev/null || die "claude is not on PATH." "Install Claude Code and sign in."
  command -v gh >/dev/null || die "gh is not on PATH." "Install the GitHub CLI and run: gh auth login"
  curl -fsS --max-time 3 "${BOARD_URL:-http://127.0.0.1:4100}/api/health" >/dev/null 2>&1 ||
    die "The board is not answering." "Start it first:  ./run dev --bg"
  note "This spends real tokens — a few cents to a dollar — and opens a pull request."
  npx tsx runner/scripts/smoke.ts
}
```

with `smoke)        scenario_smoke ;;` in the `case` and
`${BOLD}smoke${OFF}      one real task against a throwaway repository (spends tokens)` in `usage`.

- [ ] **Step 2: Run the smoke once**

With prices set for the models the phases use (`./run price:set <model> …` from Anthropic's
price list; the Cost tab names any model still missing), a throwaway repository configured,
and `./run dev --bg` running:

Run: `./run smoke`
Expected: `state: review`, a pull request URL, and each phase's computed and reported cost. Write
down what it printed: the slice's review shows it. A phase flagged over 2% means a price row is
wrong — compare its model's row with Anthropic's list before anything else.

- [ ] **Step 3: The architecture document**

`docs/architecture.md` — what the board does after slice 1. Write it from the code as built;
where the code and this outline disagree, the code is right and the outline is what to fix.

```markdown
# Architecture

What the board does today. This document is authoritative; the specs in
`docs/superpowers/specs/` are decision records and say why, not what.

## The parts

| Part     | Where         | What it does                                                                                                                                                           |
| -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server   | `server/`     | One Fastify process on 127.0.0.1: the REST API under `/api`, the board MCP server at `/mcp`, server-sent events at `/api/stream`, the PR poller, and the built web app |
| Runner   | `runner/`     | `board-cli daemon` claims queued runs and drives each phase as one `claude -p`; `board-cli event` and `board-cli guard` are the hooks those calls run                  |
| Web      | `web/`        | The board, the card and its tabs, on the zellige component kit; built into `server/public/`                                                                            |
| Database | PostgreSQL 16 | Every record; `LISTEN/NOTIFY` on channel `board` carries change notices                                                                                                |

## A task's life

Backlog → (the owner saves a spec) → Spec review → (Approve) → Ready → (the runner claims) →
Running → Review → (the pull request merges) → Done. Running → Failed when a phase fails, Verify
fails three times, or a `git`/`gh` step fails; Failed → Ready on Re-run. Every move goes
through `server/src/modules/tasks/transitions.ts`; nothing else writes `tasks.state`.

## A run

The runner creates a worktree under `~/.ai-task-board/worktrees/<run>` on
`board/<KEY>-r<n>` from `origin/<base>`, and a run directory under `~/.ai-task-board/runs/<run>`
holding the agents, the hooks, the MCP configuration and the event buffer. Plan, then up to
three Build → test command → Verify rounds. Every phase is `claude -p` with
`--setting-sources project`, a run token in its environment, and the board MCP server as its
only MCP server. All criteria passing pushes the branch and opens the pull request. The
worktree is removed when the run ends.

## What the runner reports

Events, through `POST /api/runner/events`, idempotent on their ids. `phase_start`, `phase_end`
and `run_end` also move the board. Usage per message comes from the stream's `message_delta`;
a subagent's from its `Agent` result; the remainder of each process's `modelUsage` is one
`claude-code` event. While the board is unreachable, events wait in the run directory's
`events.ndjson` and replay in order.

## Costs

Never stored: every figure is events × the price row in effect on the event's day
(`./run price:set`). Each phase also keeps Claude Code's own cost; the Cost tab flags a phase
more than 2% apart, which means a stale price row.

## Security

No sign-in: the server binds 127.0.0.1, answers only to `ALLOWED_HOSTS`, and refuses writes
from a foreign `Origin`. The runner authenticates with `RUNNER_KEY`; each `claude` process gets
a run token limited to its run, retired five minutes after the process exits. The guard denies
`rm -rf`, `git push`, `git reset --hard`, `.env` files, paths outside the worktree, new
migrations, and in Build any file the plan does not list.

## Error translation

The kit's error shape and codes. A move the table refuses, or a stale one, is `409 conflict`;
a spec that does not lint, or a field that fails a check, is `400 validation_error` with
`details`. The web app never shows `message`: `web/src/errors.ts` reads the code and the field,
and each page words the problem itself.

## Accessibility

The web app targets WCAG 2.2 AA. Its widgets are the zellige kit's: the card is a modal side
`Dialog`, its sections are `Tabs`. Every drag has a button in the card's dialog — Move up, Move
down, Mark done. Each page and the open card keep a status region mounted and write outcomes into
it; the card announces its own changes of state, the board nothing the runner does. Route changes
focus the new page's `h1`; closing a card returns focus to its link. `tests/ui/` scans every
state it reaches with axe-core and drives one journey by keyboard alone.
```

- [ ] **Step 4: README, backlog, spec status**

Replace the README's "Status" section with:

```markdown
## Status

**Slice 1 built:** one task from the board to a pull request. Pausing for approvals is
slice 2, drafted specs slice 3 — see §13 of the
[MVP spec](docs/superpowers/specs/2026-10-10-mvp-design.md). What the board does today is in
[docs/architecture.md](docs/architecture.md).

## Running it

Needs Node 24, Docker, Claude Code signed in, and the GitHub CLI signed in (`gh auth login`).

    ./run dev            # PostgreSQL, the server, the web app and the runner
    open http://127.0.0.1:5174

Register a repository on the Projects page, then record the price of each model the phases
use, from Anthropic's price list, in USD per million tokens:

    ./run price:set <model id> <input> <output> <cache read> <cache write>

The Cost tab names any model that still has no price.

    ./run check          # types, formatting, every suite (needs Docker)
    ./run test:ui        # the browser journey, with a fake claude
    ./run smoke          # one real task against a throwaway repository; spends tokens
```

Add to `docs/backlog.md`, newest first:

```markdown
## A runner that dies leaves its card in Running

- Where: `server/src/modules/runner/`, which records heartbeats and has no sweeper
- Found: 2026-10-11, planning slice 1
- Problem: heartbeats are stored but nothing reads them. Kill the daemon mid-run: the card
  stays in Running and its run in `running`. Cancel moves the card; the run row stays
  `running` with `cancel_requested`.
- Impact: until slice 2's lost-runner sweeper, a crash needs a Cancel and a Re-run by hand.

## Cache writes are priced at one rate

- Where: `prices.cache_write`, `server/scripts/set-price.ts`
- Found: 2026-10-11, reading recorded runs
- Problem: Anthropic prices a one-hour cache write higher than a five-minute one. Claude Code
  2.1.212 wrote only one-hour entries in the recordings, so the row holds that rate. A run
  that writes five-minute entries is over-priced on them, and its phase drifts from Claude
  Code's own figure.
- Impact: the 2% flag fires on such phases. The usage counters stay exact; only the price is
  off. Splitting `cache_write` by TTL needs the breakdown `message_start` carries.
```

In `docs/superpowers/specs/2026-10-10-mvp-design.md`, change only the status line to:

```markdown
Status: **designed**, 2026-10-10. Slice 1 (one task, start to pull request) shipped; slices 2
and 3 not built. Read §13 for the build order.
```

- [ ] **Step 5: Archive this plan and check everything**

```bash
mkdir -p docs/superpowers/plans/archive
git mv docs/superpowers/plans/2026-10-11-slice-1-task-to-pr.md docs/superpowers/plans/archive/
./run check && ./run test:ui
```

Expected: `✓ Everything is clean`, then 3 passed.

- [ ] **Step 6: Commit**

```bash
git add runner/scripts/smoke.ts run README.md docs
git commit -m "docs: describe the board as slice 1 built it"
```

- [ ] **Step 7: Review**

End the slice with the kit's review: everything the branch changed, shown rather than listed;
the output of `./run check`, `./run test:ui` and the smoke run; every decision this plan or its
execution took that the spec did not; and what is still unproven — at least the exit gate,
which needs ten real tasks and is not part of this slice, and, for the web app, which of a
screen reader, 200% zoom and a 320 px viewport were not tried.
