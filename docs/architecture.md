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
Running → Review → (the pull request merges, or the owner marks it done) → Done. Running → Failed when a phase fails, Verify
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
