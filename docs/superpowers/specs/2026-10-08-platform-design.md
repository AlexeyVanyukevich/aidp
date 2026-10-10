# AI Task Board — Platform Design

Status: **source design**, 2026-10-08. Not built as a whole.

> **This is a decision record, not a description of the system.**
>
> It is the platform design the project started from, copied here so the record does not
> depend on a private link. It covers all five roadmap phases. What is actually being built
> first, and where it departs from this document, is decided in
> [the MVP spec](2026-10-10-mvp-design.md).
>
> For **what** the system does today, read [docs/architecture.md](../../architecture.md) once
> it exists. Where the two disagree, the architecture document is right and this one is stale.

## Overview

AI Task Board is a Jira-style board where Claude executes each task through a spec-driven run. Every run follows Spec → Plan → Build → Verify. A run pauses on the board whenever it is uncertain, and it records every step and token it spends.

**Goals**

- Multiple projects, each with its own board, repositories, runners, agents and budget.
- Every task card shows the full execution record: spec, plan, steps, tool calls, files changed, test results, tokens and cost.
- Human approval of every spec, plus approval whenever the agent hits uncertainty, risk or budget limits.
- Pluggable runners chosen per project or per task: Claude Code on a local machine, an Agent SDK service, or GitHub Actions.
- Token cost treated as a first-class metric, with budgets, model routing, caching and context isolation.

**Non-goals for v1**

- Replacing Jira for purely human work. Sync with Jira or Linear is a later integration.
- Multi-tenant SaaS billing.
- Auto-merging to the main branch. Runs end in a pull request that a person reviews.

## Core concepts and data model

A task owns one spec and many runs. Each run is a sequence of phases, steps and approval requests, and each step carries its own token usage, so cost rolls up from step to run to task to project.

| Entity          | Purpose                                               | Key fields                                                                                                                         |
| --------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Workspace       | Top-level tenant: your team or company                | id, name, members, price table, default runner                                                                                     |
| Project         | One product or repository set with its own board      | id, key (e.g. PAY), repos[], default_runner, monthly_budget_usd, agent_profiles[], mcp_profile                                     |
| Column          | A board lane mapped to a task state                   | id, project_id, name, state, order, wip_limit                                                                                      |
| Task            | Unit of work on the board                             | id (PAY-42), title, description, state, priority, assignee, labels, spec_id, budget_usd, runner_override                           |
| Spec            | Versioned contract the run must satisfy               | id, task_id, version, body_md, acceptance_criteria[], status (draft / in review / approved / superseded), approved_by, approved_at |
| Run             | One execution attempt of a task                       | id, task_id, spec_version, runner, status, phase, session_id, branch, started_at, ended_at, tokens, cost_usd                       |
| Phase           | Spec, Plan, Build or Verify inside a run              | run_id, name, agent, model, status, summary, tokens, cost_usd                                                                      |
| Step            | One logged action: tool call, subagent, message, test | run_id, phase, agent, type, tool, target, result, tokens, cost_usd, ts                                                             |
| ApprovalRequest | A question the run cannot answer itself               | id, run_id, kind, question, options[], recommendation, context_md, status, answer, answered_by, answered_at                        |
| Artifact        | Output attached to a run                              | run_id, kind (plan, diff, PR, test report, log), uri, summary                                                                      |
| AgentProfile    | Reusable agent definition                             | name, role, model, effort, tools, mcp_servers, skills, prompt                                                                      |
| RunnerConfig    | How and where a runner executes                       | kind (local / sdk / ci), endpoint, concurrency, secrets_ref                                                                        |

Store token usage as four counters on every Step, Phase and Run: input, output, cache read and cache write. Cost is derived from the workspace price table, never stored as the only source of truth, so price changes can be recomputed.

## Board and task lifecycle

The board's columns are the task states. People move cards in the human columns, and runs move them in the agent columns. Any card that needs a person lands in Needs approval, which keeps waiting work in one visible place.

**Default columns** (configurable per project):

1. **Backlog**: an idea or request, with no spec yet.
2. **Spec draft**: the spec agent drafts the spec from the task description, linked docs and the codebase.
3. **Spec review**: a person edits, then approves or rejects the spec. This gate is mandatory.
4. **Ready**: the spec is approved and queued for a runner.
5. **Running**: the card shows a live sub-status of Plan, Build or Verify.
6. **Needs approval**: the run is paused on an approval request.
7. **Review**: verify passed and a pull request is open for human code review.
8. **Done**: the pull request is merged and the card is closed.

Two side states sit outside the main flow. **Blocked** covers an external dependency or a budget exhausted. **Failed** covers verify failing after the retry limit, or a runner error. A failed card keeps its run history and can be re-run from its last good phase.

| Transition               | Who triggers it                         | Condition                                                                 |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------------------- |
| Backlog → Spec draft     | Person, or an auto-rule on label        | Task has a description                                                    |
| Spec draft → Spec review | Spec agent                              | Spec passes the lint check: every requirement has an acceptance criterion |
| Spec review → Ready      | Person                                  | Spec approved; the version is frozen for the run                          |
| Ready → Running          | Scheduler                               | Runner slot free and budget remaining                                     |
| Running → Needs approval | Agent or policy engine                  | An uncertainty trigger fires (see Uncertainty and approvals)              |
| Needs approval → Running | Person answers                          | Run resumes from its checkpoint                                           |
| Running → Review         | Verifier                                | All acceptance criteria pass and the pull request is opened               |
| Running → Failed         | Verifier or runner                      | Retry limit reached, or an unrecoverable error                            |
| Review → Done            | Person, or a pull request merge webhook | Pull request merged                                                       |

**What a task card shows**

- **Collapsed:** state, phase sub-status, model badges, cost so far against budget (for example $0.84 / $3.00), and an open-approval badge.
- **Expanded tabs:**
  - Spec, with its version history.
  - Plan.
  - Timeline: phases, steps, subagents and tool calls.
  - Files changed.
  - Tests.
  - Approvals: questions and answers.
  - Cost: tokens by phase, agent and model.
  - Artifacts: pull request link and reports.

## Spec-based workflow: Spec → Plan → Build → Verify

No code is written until a person has approved the spec. Every later phase is measured against the spec's acceptance criteria, so verify is mechanical rather than a matter of opinion.

_[Diagram in the source doc: run flow · 4 phases, 1 approval lane]_

A person always approves the spec. Plan and Build drop into Needs approval only when a trigger fires, and Verify sends work back to Build at most twice before escalating.

| Phase  | Agent       | Default model                   | Input                                           | Output                                                         | Gate                                                                                           |
| ------ | ----------- | ------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Spec   | spec-writer | Opus (high effort)              | Task description, linked docs, codebase summary | Spec with requirements, acceptance criteria and open questions | Always human approval                                                                          |
| Plan   | planner     | Sonnet                          | Approved spec, explorer findings                | Ordered steps, files to touch, test plan, cost estimate        | Auto-approve if confidence is high and the estimate is within budget; otherwise human approval |
| Build  | builder(s)  | Sonnet                          | Spec, plan, one plan step per builder           | Commits on a run branch, step logs                             | Approval on any uncertainty trigger                                                            |
| Verify | verifier    | Sonnet, or Haiku for log triage | Spec, diff, test output                         | Pass or fail per acceptance criterion, verify report           | Up to 2 fix loops back to Build, then Failed or human approval                                 |

**Spec template** (stored as Markdown and versioned):

```markdown
# Spec: <title> (PAY-42 · v3)

## Goal

One sentence: what changes for whom.

## Context

Links, related tasks, relevant files and modules.

## Requirements

1. R1 – testable statement
2. R2 – testable statement

## Acceptance criteria

- AC1 (R1): Given … When … Then …
- AC2 (R2): Given … When … Then …

## Out of scope

## Constraints

Tech stack, performance, security, compatibility.

## Open questions

All must be answered before approval.

## Budget

Max tokens / max USD for the run.
```

**Rules**

- A spec cannot be approved while open questions remain. The spec agent turns each open question into an approval request instead of guessing.
- An approved spec version is frozen. A change during a run creates v+1 and sends the card back to Spec review.
- The plan must map every step to at least one requirement, and every acceptance criterion to at least one test or check.
- Verify reports per criterion, for example AC1 ✔ and AC2 ✘ with evidence, and that report is shown on the card.

## Uncertainty and approvals

When a run is uncertain, it checkpoints, posts a structured question to the card, and stops spending tokens. You answer on the board and the run resumes from the checkpoint. It never waits idle while holding a session open.

**What triggers an approval request**

| Trigger                            | Raised by                | Example                                                            |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| Ambiguity                          | Agent                    | The spec says "retry on failure" without a limit or backoff        |
| Competing approaches               | Agent                    | Two designs with real trade-offs: a new table versus a JSON column |
| Out-of-plan change                 | Policy (PreToolUse hook) | An edit to a file not listed in the plan                           |
| Destructive or irreversible action | Policy                   | Migration, data deletion, dependency major upgrade, force-push     |
| Budget threshold                   | Policy                   | Run reaches 80% of its budget                                      |
| Repeated failure                   | Verifier                 | Verify fails twice on the same criterion                           |
| Low confidence                     | Agent                    | Self-reported confidence below the project threshold               |

**How it works**

1. The agent calls the board MCP tool `request_approval` with a structured payload. A policy hook can raise the same request without the agent's involvement.
2. The runner writes a checkpoint: session id, run branch and commit, current phase and step, and a short state summary. It then ends the process, so a paused run costs nothing.
3. The card moves to Needs approval and you get a notification (in-app, Slack or email).
4. You pick an option or type an answer. You can also edit the spec, which creates a new version.
5. The board emits `approval.answered`. The runner resumes the session with the answer injected as the next message.
6. If nobody answers before the timeout (default 48 hours), the card moves to Blocked. The run is never auto-approved.

**Approval request payload**

```json
{
  "run_id": "run_0193",
  "task_id": "PAY-42",
  "kind": "ambiguity",
  "question": "How many retries for failed webhook delivery?",
  "options": [
    {
      "id": "a",
      "label": "3 retries, exponential backoff",
      "impact": "Matches the existing email worker"
    },
    {
      "id": "b",
      "label": "5 retries, then dead-letter queue",
      "impact": "New DLQ table; +1 plan step"
    }
  ],
  "recommendation": "a",
  "context_md": "Spec R3 is silent on limits. src/workers/email.ts uses 3 with backoff.",
  "blocking": true
}
```

For tools that must never run without a person, the MCP server marks them with `_meta["anthropic/requiresUserInteraction"]: true`. In headless runs Claude Code then denies the call rather than auto-approving it, and the policy turns that denial into an approval request.

## Pluggable runners

All runners implement one interface and emit the same event stream. You choose the runner per project, override it per task, or let routing rules pick one.

**Runner interface**

```ts
interface Runner {
  start(run: RunSpec): Promise<RunHandle> // spec, plan, agents, mcp profile, budget
  resume(run: RunHandle, answer: ApprovalAnswer): Promise<void>
  cancel(run: RunHandle): Promise<void>
  events(run: RunHandle): AsyncIterable<RunEvent> // normalized step + usage events
  capabilities(): { parallel: number; resumeBySession: boolean; localSecrets: boolean }
}
```

|                | Claude Code (local)                                                                  | Agent SDK service                                            | GitHub Actions                                                                                     |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Where it runs  | A developer's machine or a dev box, via a small runner daemon                        | Your backend workers (container per run)                     | CI runners triggered from the board                                                                |
| Start          | `claude -p --output-format stream-json --mcp-config board.json --agents agents.json` | `query()` with `agents`, `mcpServers`, `hooks`, `canUseTool` | `repository_dispatch` → workflow using the Claude Code action                                      |
| Pause / resume | Exit on approval, then `claude -p --resume <session_id> "<answer>"`                  | Exit on approval, then resume the session id with the answer | Job ends; resume = new dispatch that rebuilds context from the run branch plus the checkpoint file |
| Logging        | stream-json events plus hooks POST to the board                                      | SDK message stream plus hooks                                | Workflow posts events to the board webhook                                                         |
| Best for       | Work needing local tools, secrets or private networks; cheapest to start             | Many parallel runs, always-on, SLA                           | Reproducible repo-only work, audit trail in CI                                                     |
| Watch out      | Machine must be online; one user's credentials                                       | You operate the infrastructure                               | Cold start each time; resume is a rebuild, not a true session resume                               |

**Routing rules** (evaluated in order, first match wins):

1. A task-level `runner_override` wins.
2. The task needs local-only resources (VPN, local database, hardware) → Claude Code local.
3. The task is labeled `ci` or the project policy requires CI audit → GitHub Actions.
4. The task's parallelism need is above the local limit, or no local runner is online → Agent SDK service.
5. Otherwise, use the project default.

Each runner reports a heartbeat every 30 seconds. A run whose runner misses 3 heartbeats is marked Blocked, keeping its checkpoint so another runner can resume it.

## Multi-agent orchestration: one context, multiple minds

Each run has one orchestrator that holds the spec and plan, and delegates to specialized agents that return only short tagged summaries. Forks are used when a worker needs the whole conversation; subagents are used when it does not.

| Role         | Type                                          | Model / effort               | Tools                                                               | Returns                              |
| ------------ | --------------------------------------------- | ---------------------------- | ------------------------------------------------------------------- | ------------------------------------ |
| orchestrator | Main session (`--agent orchestrator`)         | Sonnet, medium               | Agent(spec-writer, planner, explorer, builder, verifier), board MCP | Phase transitions, approval requests |
| spec-writer  | Subagent                                      | Opus, high                   | Read, Grep, Glob, board MCP                                         | `<spec>`                             |
| explorer     | Subagent (read-only)                          | Haiku, low                   | Read, Grep, Glob                                                    | `<findings>`                         |
| planner      | Subagent                                      | Sonnet, medium               | Read, Grep, Glob                                                    | `<plan>` with cost estimate          |
| builder      | Subagent, `isolation: worktree` when parallel | Sonnet, medium               | Read, Edit, Write, Bash, scoped MCP                                 | `<build_report>`                     |
| verifier     | Subagent, fresh context                       | Sonnet; Haiku for log triage | Read, Bash (tests), Playwright MCP inline                           | `<verify_report>` per criterion      |

**Forks or subagents**

- **Fork** (inherits the full conversation and shares the prompt cache): use it to try two plan alternatives side by side, or for a side task that needs everything said so far.
- **Subagent** (fresh, isolated context): use it for exploration, test runs, log reading and independent build steps. These produce verbose output the orchestrator should never see.
- **The verifier is always a fresh subagent.** It sees the spec and the diff, not the builder's reasoning, so it does not grade its own work.

**Handoff contract.** Every delegation and every return uses the same XML tags, so the orchestrator and the board can parse them:

```xml
<task id="PAY-42" phase="build" step="3/5">Add exponential backoff to webhook retries</task>
<spec_ref version="3">R3, AC3</spec_ref>
<context>Plan step 3; touch only src/workers/webhook.ts and its test</context>
<constraints>No new dependencies. Stop and request approval if another file must change.</constraints>
<budget tokens="60000"/>
<return_format>
  <build_report status="done|blocked" files="…" tests="…" confidence="high|medium|low"/>
</return_format>
```

**Shared knowledge without shared history**

- Project conventions live in skills preloaded per agent (`skills:` in the frontmatter), not repeated in prompts.
- Agents with `memory: project` accumulate patterns in `.claude/agent-memory/<agent>/`, versioned with the repository.
- The orchestrator stores phase summaries on the board, so a resumed run, or a different runner, rebuilds context from roughly 2,000 tokens of summary, not the full transcript.
- Concurrency follows Claude Code's defaults: up to 20 concurrent subagents and a nesting depth of 3. The platform caps both lower per project, for example 4 builders.

## Token cost optimization

Cost is controlled in three layers: send less context, use the cheapest model that can do each job, and enforce hard budgets that pause rather than overspend. Every lever below is measurable on the card's Cost tab, so you can see which ones pay off.

**1. Send less context**

- **Subagents return summaries only.** Test logs, search results and file dumps stay in the worker's context; the orchestrator receives a tagged report of a few hundred tokens.
- **Scope MCP servers per agent.** Define heavy servers, such as Playwright or a database server, inline on the agent that needs them, not in `.mcp.json`, so their tool descriptions never load in the orchestrator.
- **Keep tool search on**, which is the default. Use `alwaysLoad` only for the board MCP server.
- **Cap tool output** with `MAX_MCP_OUTPUT_TOKENS`. Large results go to a file the agent reads only if needed.
- **Trim workers' context.** Use `omitClaudeMd: true` on workers that receive everything in the delegation prompt, and preload only the skills each role needs.
- **Resume from summaries.** Resumed and re-run tasks start from the stored phase summaries, not by replaying transcripts.

**2. Route models and effort**

| Work                                                          | Model  | Effort |
| ------------------------------------------------------------- | ------ | ------ |
| Exploration, log triage, classification, spec lint            | Haiku  | low    |
| Planning, building, verifying                                 | Sonnet | medium |
| Spec writing, hard design trade-offs, failed-twice escalation | Opus   | high   |

Escalate a model only on a trigger (verify failed twice, or low confidence), never by default. Record the escalation as a step so its cost shows up on the card.

**3. Cache**

- Keep each agent's system prompt, tools and skills stable across runs so prompt caching hits. Volatile data (task id, step) goes at the end of the prompt.
- Prefer forks for side tasks that need the full context, because they reuse the parent's prompt cache.
- For long runs with pauses, set `experimental.cacheTtl: 1h` on agents where cache writes repeat.
- Track the cache hit ratio (cache read ÷ total input) per agent. A falling ratio usually means a prompt is changing between runs.

**4. Enforce budgets**

| Level   | Default                                | At 80%                                    | At 100%                                        |
| ------- | -------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| Run     | From spec `Budget`, or the task budget | Approval request: continue, raise or stop | Hard stop and checkpoint; card goes to Blocked |
| Task    | Sum of runs, set by a person           | Warning badge on card                     | No new runs without approval                   |
| Project | Monthly USD cap                        | Notify the project owner                  | Queue new runs until approved                  |

The planner outputs a cost estimate per step. The platform compares estimate with actual after each run and shows the error, which improves future estimates and budget settings.

**5. Avoid re-work**

Most waste comes from building the wrong thing, so the strict spec gate is the biggest cost lever. Other ways to avoid repeat work:

- Re-runs restart from the last good phase, for example Build, instead of from Spec.
- Approved plans for similar tasks are offered to the planner as examples.
- Non-urgent bulk work, such as nightly spec linting across a backlog, runs on the Agent SDK service in batch mode where available.

## Execution logging and observability

Every runner converts what it sees into one normalized event schema and sends it to the board. The card's timeline, the cost tab and the project dashboards are all views over that single event table.

**Event sources**

| Source                                                                       | What it gives                                                                          | Used for                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Runner output (stream-json, SDK messages)                                    | Assistant messages, tool calls, per-message token usage, session id, MCP server errors | Timeline, token counters, session id for resume        |
| Hooks (`PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`) | Tool name and input, subagent type, start and stop times                               | Step log, out-of-plan policy checks, agent durations   |
| Board MCP tools (`log_step`, `set_phase`, `request_approval`)                | Agent-declared phase changes, summaries, confidence                                    | Phase status, summaries, approvals                     |
| Transcripts (`~/.claude/projects/…/subagents/agent-<id>.jsonl`)              | Full raw history                                                                       | Deep debugging only; linked from the run, not ingested |
| Git and CI webhooks                                                          | Commits, pull request, check results                                                   | Files changed, Review and Done transitions             |

**Normalized event**

```json
{
  "event_id": "evt_7f3c",
  "ts": "2026-10-08T13:20:11Z",
  "workspace": "acme",
  "project": "PAY",
  "task_id": "PAY-42",
  "run_id": "run_0193",
  "runner": "local",
  "phase": "build",
  "agent": "builder",
  "model": "sonnet",
  "type": "tool_call",
  "tool": "Edit",
  "target": "src/workers/webhook.ts",
  "status": "ok",
  "duration_ms": 412,
  "usage": { "input": 1840, "output": 312, "cache_read": 41200, "cache_write": 0 },
  "cost_usd": null
}
```

The runner leaves `cost_usd` null; the cost service fills it from the workspace price table. Event types are `phase_start`, `phase_end`, `message`, `tool_call`, `subagent_start`, `subagent_stop`, `approval_requested`, `approval_answered`, `checkpoint`, `budget_threshold`, `error` and `run_end`.

**Logging hook for the local runner** (`.claude/settings.json`):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "board-cli event --stdin --type tool_call" }]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [{ "type": "command", "command": "board-cli event --stdin --type subagent_start" }]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [{ "type": "command", "command": "board-cli event --stdin --type subagent_stop" }]
      }
    ]
  }
}
```

**What you see**

- **Card timeline:** phases as bands, steps inside them, subagents nested, approvals as markers. Click a step to see its input, its result summary and its tokens.
- **Cost tab:** tokens and USD by phase, agent and model, the cache hit ratio, and the plan estimate against the actual cost.
- **Project dashboard:** spend per day against the monthly cap, cost per task, runs per runner, approval wait time, verify pass rate on first try, and the most expensive agents.
- **Alerts:** budget thresholds, runners with no heartbeat, approvals waiting more than 24 hours, and cache hit ratio drops.

## MCP configuration

The board itself is an MCP server that every runner connects to, which is how agents read specs, log steps and ask for approval. Every other server is scoped to the agents that need it.

**Board MCP server tools**

| Tool                       | Used by           | Purpose                                                                    |
| -------------------------- | ----------------- | -------------------------------------------------------------------------- |
| `get_task`, `get_spec`     | All               | Read the task and the frozen spec version                                  |
| `set_phase`                | orchestrator      | Move the run between Spec, Plan, Build and Verify; posts the phase summary |
| `log_step`                 | All               | Agent-declared step with summary and confidence (complements hooks)        |
| `save_plan`, `save_report` | planner, verifier | Attach the plan or verify report as artifacts                              |
| `request_approval`         | All               | Create an approval request and signal the runner to checkpoint             |
| `checkpoint`               | orchestrator      | Store session id, branch, commit and state summary                         |

**Project `.mcp.json`** (committed; secrets come from environment variables):

```json
{
  "mcpServers": {
    "board": {
      "type": "http",
      "url": "${BOARD_URL:-https://board.example.com}/mcp",
      "headers": { "Authorization": "Bearer ${BOARD_RUN_TOKEN}" },
      "alwaysLoad": true
    },
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GH_RUN_TOKEN}" }
    }
  }
}
```

**Per-agent servers** (verifier frontmatter):

```yaml
---
name: verifier
description: Checks a diff against the spec's acceptance criteria. Use after every build phase.
tools: Read, Grep, Glob, Bash, mcp__board
model: sonnet
mcpServers:
  - playwright:
      type: stdio
      command: npx
      args: ['-y', '@playwright/mcp@latest']
---
```

**Rules**

- Always set `type` on remote entries. An entry with a `url` and no `type` is read as stdio and is skipped.
- Use your own variable names for tokens, such as `BOARD_RUN_TOKEN`. Claude Code reads its own and cloud credential variables as empty in remote headers.
- Issue a short-lived, run-scoped token per run. It can only touch that run's task and expires when the run ends.
- Restrict OAuth servers with `oauth.scopes`, and narrow agents with `disallowedTools`, for example `mcp__github` on the explorer.
- Mark destructive tools on your own servers with `anthropic/requiresUserInteraction` so they always route to an approval.
- For the CI runner, pass the config explicitly with `--mcp-config` and `--strict-mcp-config`, so nothing else loads.

## Architecture and API

The board is a web app plus an API server over Postgres. Runners never talk to the database directly. They connect through a runner gateway and the board MCP server, so any runner can be swapped without touching the board.

_[Diagram in the source doc: architecture · core, gateway, 3 runners]_

The gateway dispatches work to whichever runner the routing rules pick. Every runner reports back through the same board tools, so the core never knows which one ran the task.

**Components**

| Component                   | Responsibility                                                                          | Suggested tech                         |
| --------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| Web app                     | Boards, cards, spec editor, approvals, dashboards; live updates over server-sent events | Next.js, React                         |
| API server                  | Projects, tasks, specs, runs, approvals; auth; webhooks                                 | Node/TypeScript                        |
| Database                    | All entities and the event table                                                        | Postgres (events partitioned by month) |
| Queue / event bus           | Run scheduling, `approval.answered`, runner commands                                    | Redis Streams or NATS                  |
| Scheduler and policy engine | Routing rules, budgets, retry limits, uncertainty policies                              | Part of the API server                 |
| Runner gateway              | Dispatch to local daemons, SDK workers or GitHub Actions; heartbeats; resume            | Node/TypeScript                        |
| Board MCP server            | Tools agents call (see MCP configuration)                                               | MCP over HTTP                          |
| Cost service                | Applies the price table to usage; budget thresholds                                     | Worker                                 |
| Local runner daemon         | Polls the gateway, runs `claude -p`, streams events                                     | Small CLI (`board-cli`)                |
| SDK worker                  | Runs the Agent SDK in a container per run                                               | TypeScript Agent SDK                   |

**API** (REST; all endpoints scoped to a workspace):

| Method | Path                     | Purpose                                                |
| ------ | ------------------------ | ------------------------------------------------------ |
| POST   | `/projects`              | Create a project with repos, default runner and budget |
| POST   | `/projects/{key}/tasks`  | Create a task                                          |
| PATCH  | `/tasks/{id}`            | Edit or move a task                                    |
| POST   | `/tasks/{id}/spec`       | Create a new spec version (draft)                      |
| POST   | `/specs/{id}/approve`    | Approve and freeze a spec version                      |
| POST   | `/tasks/{id}/runs`       | Start a run (optional runner override, budget)         |
| POST   | `/runs/{id}/cancel`      | Cancel a run                                           |
| GET    | `/runs/{id}/events`      | Event stream (server-sent events) for the timeline     |
| POST   | `/approvals/{id}/answer` | Answer an approval request; triggers resume            |
| POST   | `/runner/events`         | Runners post normalized events (run token)             |
| POST   | `/runner/heartbeat`      | Runner liveness                                        |
| GET    | `/projects/{key}/costs`  | Cost dashboard data by day, agent and model            |

The runner gateway and runners call the API with a run-scoped token. People use workspace sign-in (SSO). Webhooks out (`run.ended`, `approval.requested`) let Slack, Jira or other tools subscribe.

## Security and permissions

Agents get the least access that lets them finish their phase. Anything destructive or outside the plan becomes an approval, and every action is in an append-only audit log.

- **Isolation:** every run works on its own branch; parallel builders use worktrees. No agent can push to the main branch; branch protection enforces this, not prompts.
- **Permission modes per role:**
  - explorer and verifier: read-only.
  - builder: `acceptEdits` inside its worktree only.
  - No role ever uses `bypassPermissions`.
- **Tool policy:** a `PreToolUse` hook checks every Bash command and edit against the plan's file list and a deny list (for example `rm -rf`, `git push --force`, migrations, `.env` files). A match raises an approval request.
- **Secrets:**
  - Stored per project in a vault and injected as environment variables for one run.
  - Never written into specs, prompts or logs. The event pipeline redacts token-like strings.
- **Credentials:**
  - Run tokens are short-lived and scoped to one task.
  - The local runner uses the developer's own Claude login; the SDK and CI runners use a workspace API key.
- **Prompt injection:** content from issues, web pages and repositories is treated as data. Agents never act on instructions found in it without an approval request. Verifier output is checked by the orchestrator before any state change.
- **Roles:**
  - Workspace admin: runners, budgets, price table.
  - Project owner: agents, policies.
  - Member: create tasks, approve specs and answer approvals.
  - Viewer: read only.
- **Audit:** spec approvals, approval answers, budget overrides and runner changes are recorded with user and timestamp, and cannot be edited.

## Roadmap and open questions

Build the local runner end to end first. It proves the spec gate, approvals and cost logging with the least infrastructure; the other runners then reuse the same interface.

1. **MVP: one project, local runner.**
   - Board with columns, tasks and spec editor with approval.
   - Board MCP server.
   - Local runner daemon running `claude -p` with logging hooks.
   - Run timeline and cost tab.
   - Exit gate: 10 real tasks complete with every cost visible per step.
2. **Approvals and budgets.**
   - Policy engine: uncertainty triggers, out-of-plan hook, budget thresholds.
   - Checkpoint and resume.
   - Notifications.
   - Exit gate: a paused run resumes correctly from a board answer.
3. **Multi-project and agents.**
   - Agent profiles per project, model routing, forks and parallel builders in worktrees.
   - Project dashboards.
4. **More runners.**
   - Agent SDK service and the GitHub Actions runner.
   - Routing rules, heartbeats and failover.
5. **Integrations.** Jira or Linear sync, Slack approvals, webhooks out.

**Open questions**

- [ ] Self-hosted only, or also a hosted version for other teams?
- [ ] Which repositories and languages come first? This decides the default verifier tooling.
- [ ] Should answering an approval be restricted to the task's assignee, or open to any project member?
- [ ] Default budgets per task and per project, and who may raise them?
- [ ] Is GitHub the only code host, or are GitLab and Bitbucket needed too?
- [ ] How long to keep raw transcripts versus normalized events? Claude Code deletes transcripts after 30 days by default.
