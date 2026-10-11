# AI Task Board — MVP

Status: **designed**, 2026-10-10. Not built. Read §13 for the build order.

> **This is a decision record, not a description of the system.**
>
> It states what was decided on 2026-10-10, before any of it was built. It is not revised as
> the code moves on.
>
> Read it to learn **why** something has the shape it does. For **what** the system does today,
> read [docs/architecture.md](../../architecture.md) once it exists. Where the two disagree, the
> architecture document is right and this one is stale.

This is the founding design record of this repository. The
[platform design](2026-10-08-platform-design.md) is its source: this document picks the first
release out of it and records every place it departs from it. Anything the platform design
specifies and this one does not mention is out of scope.

Throughout:

- **the owner** is the one person who uses the board;
- **a target repository** is a repository the board carries tasks out in — the owner's own
  TypeScript projects, hosted on GitHub;
- **the runner** is the `board-cli daemon` process that runs Claude Code on the owner's machine;
- **the kit** is the `dev-kit` package that holds the conventions this repository follows.

---

## 1. Purpose

A board where each task is carried out by Claude through Spec → Plan → Build → Verify, with the
owner approving every spec, answering every question the agent cannot settle itself, and seeing
every step and token a run spent.

### The driving case

The owner writes a task on the board, approves its spec, and later finds a pull request in the
target repository, with every step the agent took and what each one cost on the card.

### Exit gate

The MVP is done when **10 real tasks** across at least two target repositories have reached
Review with a pull request, and for each of them:

- the cost of every step is visible on the card;
- the board's computed cost is within 2% of the cost Claude Code reported (§4);

and **at least one** of the ten paused on an approval request and resumed correctly from an
answer given on the board.

## 2. Decisions taken while scoping

| Question                    | Decision                                                                                                    | Why                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Who uses the MVP first      | The owner alone, on the owner's machine, against their own target repositories                              | Removes sign-in, roles and runners on other machines from the release                                |
| How a run ends              | The branch is pushed and a PR opened with `gh`; the server polls the PR and moves the card to Done on merge | Keeps the platform design's "runs end in a PR a person reviews" without a public webhook endpoint    |
| What happens on uncertainty | Pause, then resume the same Claude session — pulled forward from roadmap phase 2                            | Without it the exit gate tests a workflow the product will not have                                  |
| Who drives the phases       | The runner, one `claude -p` per phase (§6)                                                                  | Phase order, the fix-loop limit and the verifier's independence are enforced in code, not in prompts |

### Departures from the platform design

| Platform design                                  | MVP                                                                       | Reason                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| One orchestrator session delegates to subagents  | The runner is the orchestrator; each phase is its own `claude -p`         | Decided above. A later runner may choose its own strategy behind the same interface                   |
| `set_phase` and `checkpoint` are agent tools     | Owned by the runner; not exposed to agents                                | The runner already knows the phase and owns the process                                               |
| Configurable `Column` entity                     | Columns are the fixed task states                                         | Nothing in the MVP needs another layout                                                               |
| Next.js web app                                  | Vite + React single-page app                                              | The stack the owner's other projects already use; a board on localhost needs no server rendering      |
| Redis Streams or NATS                            | PostgreSQL `LISTEN/NOTIFY` and a long-poll                                | One runner and one server; a bus has nothing to fan out to                                            |
| Workspaces, SSO, roles                           | None; the server binds to `127.0.0.1`                                     | One user                                                                                              |
| Usage counters on Step, Phase and Run            | Counters on events only; totals are SQL sums                              | Rollup columns can drift; at one user's scale sums are cheap                                          |
| Separate Files changed, Tests and Artifacts tabs | One PR tab                                                                | Each would hold one short list                                                                        |
| Verify failing twice → Failed or human approval  | → Failed                                                                  | Re-run from the board covers the approval case                                                        |
| Budgets with thresholds                          | Out, except `--max-budget-usd` on each phase when a task has `budget_usd` | Budgets are roadmap phase 2; the backstop stops a runaway phase from spending past what the owner set |

### Out of scope

Agent SDK and GitHub Actions runners, routing rules, budget thresholds and their approvals,
notifications, dashboards, agent profiles per project, model escalation, forks, parallel
builders, re-running from the last good phase, integrations, a phone layout.

## 3. Components

```
ai-task-board/
  server/    Fastify API, board MCP server, cost service, PR poller, sweepers
  web/       Vite + React single-page app
  runner/    board-cli: `daemon` drives runs; `event` and `guard` are called by hooks
  docs/      architecture.md, backlog.md, superpowers/specs, superpowers/plans
  run        ./run dev | up | down | check | smoke
  docker-compose.yml   PostgreSQL only
```

npm workspaces, Node 24 or later.

**The kit, at `v2.2.0`.** Installed over git, `github:AlexeyVanyukevich/dev-kit#v2.2.0` — the
kit's documented fallback, which needs no registry configuration; the private registry the kit
prefers has not been set up. Sections load where the kit's README says a
repository with a backend and a UI loads them:

| `CLAUDE.md` | Sections            | tsconfig                   |
| ----------- | ------------------- | -------------------------- |
| root        | `common`, `testing` | —                          |
| `server/`   | `backend`           | `dev-kit/backend/tsconfig` |
| `runner/`   | `backend`           | `dev-kit/backend/tsconfig` |
| `web/`      | `ui`                | `dev-kit/ui/tsconfig`      |

The runner serves no HTTP and owns no database, so two of the four `backend` rules do not apply
to it; it takes the section for the `NodeNext` rule, and a section is loaded whole. Prettier is
`dev-kit/common/prettier`, `./run` sources the kit's `lib.sh`, and `.gitignore` starts as the
kit's copy.

**Server.** One Node process: the REST API, the board MCP server at `/mcp` (streamable HTTP),
server-sent events for the web app, the cost service, the PR poller, and two sweepers (the
approval timeout and the lost-runner check). PostgreSQL through Kysely, TypeBox from the
`typebox` package. Code follows the kit's layout, `src/modules/<entity>/` with its routes,
schemas, service and repository. Three rules are pure functions in their own files, importing
nothing from `db/`: the transition table (§5), the spec parser and lint (§4), and pricing.

**Runner.** `board-cli daemon` runs on the owner's machine. It long-polls the server for work,
handles one run at a time, and runs every phase with the `claude` CLI in a git worktree of the
target repository. Its state lives outside every repository:

```
~/.ai-task-board/
  worktrees/<run-id>/   the run's checkout
  runs/<run-id>/        agents.json, settings.json, mcp.json, events.ndjson, stderr logs
```

so nothing the board needs ends up in a target repository.

## 4. Data model

A task's `state` is its column: Backlog, Spec draft, Spec review, Ready, Running, Needs
approval, Review, Done, plus Blocked and Failed.

| Table               | Key fields                                                                                                                                                | Notes                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `projects`          | key (`PAY`), name, repo_path, github_repo, base_branch, test_command                                                                                      | One per target repository                                      |
| `tasks`             | project_id, number, title, description_md, state, position, budget_usd                                                                                    | Shown as `PAY-12`; `position` orders cards inside a column     |
| `specs`             | task_id, version, body_md, criteria jsonb, status, approved_at                                                                                            | Unique (task_id, version). Status: draft, approved, superseded |
| `runs`              | task_id, kind (`spec` \| `delivery`), spec_version, status, current_phase, branch, worktree_path, pr_number, pr_url, fix_loops, started_at, ended_at      | Drafting the spec is a run of its own                          |
| `run_tokens`        | run_id, token_hash, expires_at                                                                                                                            | One per `claude` process launch                                |
| `phases`            | run_id, name, attempt, agent, model, status, session_id, summary_md, started_at, ended_at                                                                 | One row per attempt, so fix loops show as attempts 2 and 3     |
| `events`            | id (client-generated), run_id, phase_id, ts, type, agent, model, tool, target, status, duration_ms, input, output, cache_read, cache_write, payload jsonb | The platform design's Step and event table, merged             |
| `approval_requests` | run_id, phase_id, kind, question, options jsonb, recommendation, context_md, status, answer jsonb, checkpoint jsonb, created_at, answered_at              | Status: open, answered, expired                                |
| `artifacts`         | run_id, kind (plan, verify_report, pr), body_md, uri                                                                                                      |                                                                |
| `prices`            | model, effective_from, input, output, cache_read, cache_write (USD per million tokens)                                                                    | Editable rows                                                  |

**Cost** is never stored. A task's, run's or phase's cost is the sum over its events of each
counter times the price row in effect for that event's model on the event's date.

**Prices are a fact about the outside world,** and nothing publishes them in a form the board
can fetch. The rows are entered from Anthropic's price list when the server is first set up,
and kept honest by the reconciliation below: a price that goes stale shows up as every phase on
that model drifting from what Claude Code reported. Tests use fixture prices and never the real
ones.

**Usage sources.** Corrected on 2026-10-11 from two recorded runs of Claude Code 2.1.212, before
anything was built; the first version of this paragraph assumed per-message usage was final.

- **The phase agent's messages:** `message_start` and `message_delta` stream events, which
  `--include-partial-messages` turns on. `message_delta` carries the final output count. The
  `assistant` events cannot be used for this: each content block of one message repeats the
  same `usage`, and its `output_tokens` is the count when streaming began.
- **A subagent:** the `tool_use_result` of the phase agent's `Agent` call, which carries the
  subagent's whole usage, its type and its model. Subagents run as background tasks and send
  no stream events of their own; their messages carry `parent_tool_use_id`.
- **Claude Code's own calls:** small requests the CLI makes that appear as no message. The last
  `result` message of a process carries `modelUsage`, the process's cumulative totals per
  model. The runner records the difference between those totals and everything it attributed
  as one `message` event with agent `claude-code`, so the counters on the card sum to exactly
  what Claude Code counted.
- Hooks add tool calls, which carry no usage.

One process can emit several `result` messages, since a subagent's completion starts a new turn;
only the last one counts. `modelUsage` also carries Claude Code's own `costUSD` per model, which
the runner records on `phase_end`. The cost tab flags a phase whose computed cost differs from it
by more than 2%: with the counters exact, that difference can only be a stale price row.

**Event types** are the platform design's list without `budget_threshold`: `phase_start`,
`phase_end`, `message`, `tool_call`, `subagent_start`, `subagent_stop`,
`approval_requested`, `approval_answered`, `checkpoint`, `error`, `run_end`.

### The spec

The platform design's spec template is the format. On every save the server parses:

- **requirements**: the numbered items under `## Requirements`, each `R<n>`;
- **acceptance criteria**: the items under `## Acceptance criteria`, each `AC<n> (R<n>[, R<m>])`;
- **open questions**: the non-empty items under `## Open questions`.

The **lint** fails when a requirement has no acceptance criterion, a criterion names a
requirement that does not exist, or an id repeats. A spec can be approved only when the lint
passes and no open questions remain. Approval stores the parsed criteria in `criteria` and
freezes the version; any later edit creates version n+1 as a draft.

## 5. Task lifecycle

Every state change goes through one pure module, a table of (from, to, actor, guard). The HTTP
routes, the MCP tools, the runner endpoints and the sweepers call it; none of them sets `state`
directly.

| From → To                              | Actor                                                       | Guard                                                       |
| -------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Backlog → Spec draft                   | Owner: **Draft spec**                                       | Description not empty. Creates a spec run                   |
| Spec draft → Spec review               | Runner: spec run ended                                      | A spec version was saved                                    |
| Backlog or Spec draft → Spec review    | Owner: saves a spec by hand                                 | —                                                           |
| Spec review → Spec draft               | Owner: **Redraft** with a note                              | Creates a spec run that receives the note                   |
| Spec review → Ready                    | Owner: **Approve**                                          | Lint passes, no open questions. Creates a delivery run      |
| Ready → Running                        | Runner: claimed                                             |                                                             |
| Spec draft or Running → Needs approval | MCP `request_approval`, or runner: plan not high confidence | The run's process is live (MCP); the plan is saved (runner) |
| Needs approval → Spec draft or Running | Owner: answers                                              | Approval open. The run resumes                              |
| Needs approval → Blocked               | Sweeper                                                     | Open for 48 hours. Never auto-approved                      |
| Spec draft or Running → Blocked        | Runner or sweeper                                           | Runner lost, or a `git` / `gh` step failed                  |
| Blocked → Spec draft or Running        | Owner: **Resume**                                           | The run has a resumable session                             |
| Running → Review                       | Runner                                                      | Every criterion passed and the PR is open                   |
| Spec draft or Running → Failed         | Runner, or owner: **Cancel**                                | `claude` failed, fix loops exhausted, or cancelled          |
| Failed → Ready                         | Owner: **Re-run**                                           | Creates a new delivery run from Plan                        |
| Review → Done                          | PR poller, or owner drags                                   | PR merged (poller); none (drag)                             |
| Review → Failed                        | PR poller                                                   | PR closed without merging                                   |

Cards can be reordered by drag inside any column. The only move between columns by drag is
Review → Done; every other move is a button whose action the table names.

**Two kinds of refusal**, in the kit's error shape:

- A move the table never allows from the current state, or one whose state changed since the
  client read it — another tab, or the runner moving the card — is `409 conflict`: the client's
  view was stale, and it re-reads and retries.
- A guard that fails on content — approving a spec whose lint fails or that has open
  questions, drafting a spec from an empty description — is `400 validation_error`, with the
  lint findings or the failing field in `details`.

## 6. Runs

### Phases

| Phase           | Agent       | Model, effort    | Permission mode and tools                                   | Ends with                 |
| --------------- | ----------- | ---------------- | ----------------------------------------------------------- | ------------------------- |
| Spec (spec run) | spec-writer | `opus`, high     | default; Read, Grep, Glob, board MCP                        | `save_spec`               |
| Plan            | planner     | `sonnet`, medium | default; Read, Grep, Glob, Agent(explorer), board MCP       | `save_plan`               |
| Build           | builder     | `sonnet`, medium | `acceptEdits`; Read, Edit, Write, Bash, board MCP           | commits, `<build_report>` |
| Verify          | verifier    | `sonnet`, medium | default; Read, Grep, Glob, Bash, Agent(explorer), board MCP | `save_report`             |

`explorer` is a read-only subagent (`haiku`, low effort) for searching the codebase and reading
logs; only its summary reaches the phase agent.

**Spec run.** A detached worktree at `origin/<base_branch>`. The spec-writer drafts from the
task description and the codebase, raises an approval request for each open question rather
than guessing, and saves with `save_spec`. `save_spec` returns the lint result, so the agent
fixes lint failures itself before finishing.

**Delivery run.** A worktree on a new branch `board/<TASK-KEY>-r<n>` from
`origin/<base_branch>`.

1. **Plan.** `save_plan` rejects a plan in which a step maps to no requirement or a criterion
   maps to no check. A plan the planner marks `confidence: high` goes straight to Build;
   otherwise the runner raises an approval request with the plan as its context and the
   options **Approve plan** or a free-text answer. Approving starts Build; an answer resumes
   the planner's session with it, and the revised plan goes through the same check.
2. **Build.** The builder receives the spec, the plan and, on attempts 2 and 3, the failing
   verify report. It commits its work; the runner checks there is at least one new commit.
3. **Verify.** The runner runs the project's `test_command` itself and records the result. A
   fresh verifier session receives the spec, `git diff origin/<base>...HEAD` and the test
   output, and reports pass or fail per criterion with evidence.
4. **Outcome.** All pass: the runner pushes the branch and runs `gh pr create` with the verify
   report as the body, and the card moves to Review. Any fail: back to Build, at most twice; on
   the third failed verify the card moves to Failed.

Each phase starts from a handoff in the platform design's XML contract, carrying the summaries
of the phases before it, not their transcripts.

### One phase, one call

```
claude -p "<handoff>" \
  --session-id <uuid> --agents '<contents of rundir/agents.json>' --agent <role> \
  --model <model> --effort <effort> --permission-mode <mode> \
  --allowedTools <the phase's tools> \
  --settings <rundir>/settings.json \
  --mcp-config <rundir>/mcp.json --strict-mcp-config \
  --setting-sources project \
  [--max-budget-usd <task budget>] \
  --include-partial-messages --output-format stream-json --verbose
```

`--setting-sources project` keeps the owner's user-level plugins, hooks and permissions out of
the run: a recorded run without it carried a user plugin's session hook into the agent's
context. The target repository's own project settings and `CLAUDE.md` still load. `--bare`
would isolate further but reads no OAuth login, and the runner uses the owner's.

The phase's tools go both into the agent's `tools` and into `--allowedTools`, so a headless run
never stops on a permission prompt; what those tools may touch is the guard's job, below. The
working directory is the worktree. `BOARD_URL` and `BOARD_RUN_TOKEN` reach the process through
its environment only, and `mcp.json` references them as `${…}`. The run token is issued per
process launch, is limited to that run's task, and expires five minutes after the process exits.

Every flag above was checked against Claude Code 2.1.212 on 2026-10-10.

### Hooks

`settings.json` installs:

- `PostToolUse`, `SubagentStart`, `SubagentStop` → `board-cli event`, which posts a normalized
  event, or appends it to `events.ndjson` when the server is unreachable;
- `PreToolUse` → `board-cli guard`, which denies, with a reason the agent reads:
  - the deny list: `rm -rf`, any `git push`, `git reset --hard`, edits to `.env*`, and new
    files under a migrations directory;
  - in Build, an edit to a file outside the plan's file list, with the reason "call
    `request_approval` to change a file outside the plan".

Agents never push; only the runner does. No phase uses `bypassPermissions`.

### Pause and resume

1. The agent calls `request_approval`. The server stores the request with a checkpoint (session
   id, HEAD commit, phase, attempt, the agent's summary), moves the card to Needs approval, and
   returns "Paused. End your turn now."
2. The runner waits up to 60 seconds for the process to exit, then kills it. The worktree stays
   as it is, uncommitted edits included.
3. An answer moves the card back and queues a resume. The runner runs
   `claude -p --resume <session_id> "<answer>"` in the same worktree with the same flags.

Blocked resumes the same way, with "You were interrupted. Continue from where you stopped." as
the message.

### Runner and server

The runner authenticates with a runner key from `.env`. It long-polls `POST /runner/claim` for
up to 30 seconds, which returns a work item — `start` or `resume` — or nothing; the server wakes
waiting polls with `NOTIFY`. It sends `POST /runner/heartbeat` every 30 seconds; a run whose
runner misses 3 heartbeats moves to Blocked with the reason "runner lost". After Done or Failed
the runner removes the worktree and keeps the run directory.

### PR poller

Every 3 minutes, for each card in Review, the server runs
`gh pr view <number> --repo <github_repo> --json state`: `MERGED` → Done, `CLOSED` → Failed.

## 7. Server surface

**REST.** Every body is a TypeBox schema with `additionalProperties: false`, and every error is
the kit's shape.

| Method     | Path                                 | Purpose                                                                                                                     |
| ---------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| GET, POST  | `/projects`                          | List; register a target repository (checks the path is a git repository with that remote, and that the test command exists) |
| GET, POST  | `/projects/{key}/tasks`              | Board; create a task                                                                                                        |
| GET, PATCH | `/tasks/{id}`                        | Read; edit title, description, position, or drag Review → Done                                                              |
| POST       | `/tasks/{id}/actions/{action}`       | `draft-spec`, `redraft`, `resume`, `cancel`, `rerun`                                                                        |
| GET, POST  | `/tasks/{id}/specs`                  | Versions; save a draft                                                                                                      |
| POST       | `/specs/{id}/approve`                | Approve and freeze                                                                                                          |
| GET        | `/tasks/{id}/runs`                   | Runs with phases and artifacts                                                                                              |
| GET        | `/runs/{id}/events`                  | Events, paged; the timeline                                                                                                 |
| GET        | `/tasks/{id}/costs`                  | Tokens and USD by phase, agent and model; cache hit ratio; reconciliation                                                   |
| POST       | `/approvals/{id}/answer`             | Answer; queues the resume                                                                                                   |
| GET        | `/stream`                            | Server-sent events: `task.updated`, `run.event`, `approval.requested`, `approval.answered`                                  |
| POST       | `/runner/claim`, `/runner/heartbeat` | Runner key                                                                                                                  |
| POST       | `/runner/events`                     | Run token; a batch of events, idempotent on event id                                                                        |

**MCP tools** (run token): `get_task`, `get_spec`, `save_spec` (spec run only), `save_plan`,
`save_report`, `log_step`, `request_approval`. Every call is checked against the token's run and
task.

**Localhost protections.** No sign-in is not the same as no protection: any page open in the
owner's browser can send requests to `127.0.0.1`. Every write checks `Origin` against the app's
own (`403 forbidden_origin`), and every request checks `Host` against the configured host names,
which closes DNS rebinding.

## 8. Web app

React, React Router, TanStack Query, CSS modules, desktop first. Server-sent events patch or
invalidate query caches.

- **Projects** (`/`): the list, and a form to register a target repository.
- **Board** (`/p/:key`): a column per main state; Blocked and Failed in a collapsible strip. A
  card shows its key, title, phase and attempt while Running, model badges, cost so far, and a
  badge for an open approval. The header counts open approvals across all projects.
- **Card** (a drawer, `/p/:key/:taskId`), six tabs:

| Tab       | Shows                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Spec      | Markdown editor, version picker, inline lint result; Draft spec, Redraft, Approve                                                         |
| Plan      | Steps with requirement ids, files and estimates                                                                                           |
| Timeline  | Phases as bands, attempts stacked, steps inside, subagents nested, approvals as markers; a step opens its input, result and four counters |
| Approvals | The open request first, options as buttons with the recommendation marked, a free-text answer; answered ones below                        |
| Cost      | By phase, agent and model; cache hit ratio; plan estimate against actual; the reconciliation flag                                         |
| PR        | Link and state, files changed (`gh pr view --json files`), the verify report as a table per criterion                                     |

## 9. Errors

| Failure                                                        | Result                                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A move refused by the transition table                         | `409 conflict` or `400 validation_error` (§5); nothing changes                                              |
| A missing, expired or other run's token, or a wrong runner key | `401 unauthorized`, identical in every case                                                                 |
| `claude` exits non-zero without having paused                  | Phase failed; an `error` event with the last 50 lines of stderr; card to Failed                             |
| A `git` or `gh` step fails                                     | Card to Blocked, with the command and its output; Resume retries the step                                   |
| The server is unreachable from the runner or a hook            | Events append to `events.ndjson` and replay in order when it answers; client ids make the replay idempotent |
| No new commit after Build                                      | Counted as a failed verify, against the fix loops                                                           |
| Anything unexpected on the server                              | Logged with its stack, answered `500 internal_error` with no detail                                         |

## 10. Testing

The kit's `testing` rule applies: tests before the implementation, one behaviour's cases in a
dataset table, the clock and the network injected. `backend`'s rule puts every database test
against a real PostgreSQL started by Testcontainers.

- **Unit** (`tests/unit/`): the transition table; the spec parser and lint; plan validation;
  the event normalizer, from `stream-json` and hook payloads to event rows, subagent
  attribution included; pricing at a date; the guard; the handoff builder.
- **Integration** (`tests/integration/`): the API and MCP tools end to end; token scoping;
  approval → `NOTIFY` → claim returns `resume`; cost sums and reconciliation; the approval
  timeout and lost-runner sweepers with an injected clock; the PR poller with `gh` injected; the
  `Origin` and `Host` checks.
- **Runner against a fake `claude`.** `CLAUDE_BIN` points at a script that plays a scenario
  file: it prints recorded `stream-json`, calls the board MCP and the hooks, commits, then exits
  or pauses. A fake `gh` and a local bare remote stand in for GitHub. The recorded `stream-json`
  is captured from a real `claude -p` run, not written by hand, so the normalizer is tested
  against what the CLI actually emits.
- **UI** (`tests/ui/`, Playwright, against the fake runner): register a project, write and
  approve a spec, watch the timeline fill, answer an approval, see the PR tab.
- **Smoke** (`./run smoke`, by hand, spends tokens): one small task against a scratch repository
  with the real `claude` and `gh`.

## 11. Documentation

`docs/architecture.md` does not exist yet. Slice 1 creates it, and from then on it is
authoritative for what the board does; each slice's last task updates it and `README.md`, and
archives that slice's plan. Findings left unfixed go in `docs/backlog.md`.

## 12. Open questions

Settled by this release, from the platform design's list: self-hosted, single user; TypeScript
target repositories first, so verification is the project's own `test_command`; GitHub only.

Left open, none blocking:

- [ ] How long to keep events and run directories. The MVP keeps both and links Claude Code's
      transcripts by path, which Claude Code deletes after 30 days by default.
- [ ] Default budgets per task and project, and their thresholds — roadmap phase 2.

## 13. Build order

The MVP is larger than one implementation plan. It decomposes into three slices, each useful
and testable on its own, each with its own plan.

**Slice 1 — one task, start to pull request.** The repository's skeleton on the kit; every
table in §4; projects, tasks and the spec editor with lint and approval; the runner with Plan,
Build and Verify, the event and guard hooks (deny list only — an out-of-plan edit is denied
outright), the board MCP tools without `request_approval`; push, PR and the poller; the board,
the Timeline, Cost and PR tabs. Every plan goes straight to Build, its confidence recorded. Until
slice 2 brings Blocked and Resume, a failed `git` or `gh` step fails the run, with the command
and its output on the card, and Re-run starts it again. At
the end of this slice the owner writes a spec, approves it and gets a pull request with every
step's cost on the card. **This is the slice that delivers the driving case in §1**, and nothing
below it starts first.

**Slice 2 — pause and resume.** `request_approval`; checkpoint, exit and `--resume`; the plan
confidence gate; out-of-plan edits routed to an approval; the Approvals tab; the approval
timeout, the lost-runner sweeper, Blocked and Resume. At the end of this slice a run that
cannot decide stops spending and continues from the owner's answer.

**Slice 3 — drafted specs.** The spec run and the spec-writer; open questions raised as
approvals; Redraft. It comes last because it needs slice 2's approvals, and because a spec the
owner writes by hand serves the driving case without it.

The exit gate in §1 is measured after slice 3.
