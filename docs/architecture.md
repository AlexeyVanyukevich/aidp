# Architecture

What the board does today. This document is authoritative; the specs in
`docs/superpowers/specs/` are decision records and say why, not what.

## The parts

| Part     | Where         | What it does                                                                                                                                                                        |
| -------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server   | `server/`     | One Fastify process on 127.0.0.1: the REST API under `/api`, the board MCP server at `/mcp`, server-sent events at `/api/stream`, the PR poller, the sweeper, and the built web app |
| Runner   | `runner/`     | `board-cli daemon` claims work and carries a run out in stages, each phase one Claude Code session; `board-cli event` and `board-cli guard` are the hooks its processes run         |
| Web      | `web/`        | The board, the card and its tabs, on the zellige component kit; built into `server/public/`                                                                                         |
| Database | PostgreSQL 16 | Every record; `LISTEN/NOTIFY` on channel `board` carries change notices                                                                                                             |

## A task's life

Backlog → (the owner saves a spec) → Spec review → (Approve) → Ready → (the runner claims) →
Running → Review → (the pull request merges, or the owner marks it done) → Done.

- Running → Needs approval when an agent asks, or the plan gate stops a plan its planner was
  not confident of; Needs approval → Running when the owner answers.
- Running → Blocked when the runner is lost, a `git` or `gh` step fails, or the daemon is
  stopped; Needs approval → Blocked when a question waits 48 hours. Blocked → Running on Resume,
  or — for an expired question — on its answer.
- Running → Failed when a phase fails, Verify fails three times, or the owner cancels; Ready,
  Needs approval and Blocked → Failed on Cancel. Failed → Ready on Re-run.

Every move goes through `server/src/modules/tasks/transitions.ts`; nothing else writes
`tasks.state`.

## A run

The runner creates a worktree under `~/.ai-task-board/worktrees/<run>` on `board/<KEY>-r<n>` from
`origin/<base>`, and a run directory under `~/.ai-task-board/runs/<run>` holding the agents, the
hooks, the MCP configuration, the event buffer and the files Build may change. A run goes through
stages — `prepare`, `plan`, `build`, `tests`, `verify`, `push`, `pr` — with up to three Build →
tests → Verify rounds. All criteria passing pushes the branch and opens the pull request, or
takes one already open for the branch. The worktree is removed when the run ends.

**A phase is one Claude Code session**, carried by one or more `claude -p` processes: the first
with `--session-id`, later ones with `--resume` and every other flag repeated. Each process has
`--setting-sources project`, a run token in its environment, and the board MCP server as its only
MCP server, and runs in its own process group. Its pid is kept in the run directory; a resume
first ends a process its pid file names, if that process is a `claude`.

**Checkpoints.** The runner sends a `checkpoint` event as each stage begins and after each
process: the stage, the attempt, the phase and its session with the session's last reported
totals, the worktree's HEAD, and the plan and failing report. The server keeps the latest on the
run. A resume starts from it.

**A pause.** An agent calls `request_approval`. The server pauses the phase and the run, moves the
card to Needs approval, and answers "Paused: … End your turn now." The event hook sees that
answer and writes `paused` into the run directory; from then the guard refuses every tool. The
runner gives the process 60 seconds to end its turn, then stops it; the heartbeat's `pause` list
is the backstop for a marker never written. The runner then releases the run — no `phase_end`, no
`run_end`, the worktree kept — and goes back to claiming. An answer queues a resume, which the
runner claims: the phase's session continues with the answer as its next message.

**The plan gate.** A plan not marked `confidence: high` stops at the end of the planner's process:
the runner raises a `plan` approval with the plan as its context, inside the still-open Plan
phase. Approve plan ends the phase and starts Build; an answer in words resumes the planner's
session, and its revised plan meets the gate again.

**Out-of-plan edits.** In Build the guard refuses a file outside the run's allowed list and tells
the builder to ask with `request_approval` kind `out_of_plan`. Allowing the change adds the files
to the allowed list for the rest of the run.

**Blocks.** The sweeper, every `SWEEP_MS`, blocks a running run with no heartbeat for 90 seconds
(`runner_lost`, its phase marked interrupted) and a question open for 48 hours
(`approval_expired`); a tick after a gap of more than two intervals — the machine slept —
decides nothing. The runner blocks a run whose `git` or `gh` step failed (`step_failed`, with the
command and the end of its output) and one it was stopped in (`runner_stopped`). Resume continues
from the checkpoint with "You were interrupted. Continue from where you stopped."; a stage with no
session reruns its step. A worktree that is gone fails the run; so does a session Claude Code
deleted, while a session killed before its first message is started again on a new session in
the same phase row.

**Cancel** of a paused or blocked run withdraws its question and queues a cleanup, which the
runner claims and answers by removing the worktree, found by its own path convention. A cleanup
sends no `run_end`: the board has already ended the run.

## What the runner reports

Events, through `POST /api/runner/events`, idempotent on their ids. `phase_start`, `phase_end`,
`run_end`, `checkpoint`, a blocking `error` and the plan gate's `approval_requested` also move
the board. Usage per message comes from the stream's `message_delta`; a message cut off before
it is recorded from its `message_start`, marked `cut`. A subagent's usage comes from its `Agent`
result; the remainder of each process's `modelUsage`, beyond the session's previous totals, is one
`claude-code` event. While the board is unreachable, events wait in the run directory's
`events.ndjson` and replay in order. Every request the runner makes times out — a claim's wait
plus 10 seconds, 30 seconds otherwise — and is retried.

## Costs

Never stored: every figure is events × the price row in effect on the event's day
(`./run price:set`). Claude Code reports a resumed session's usage cumulatively, so a phase's
reported cost is the sum of each process's share beyond the session's previous total. The Cost
tab flags a phase more than 2% apart from it, which means a stale price row — except a phase
marked **interrupted**, one a process of which was stopped or lost, whose own figure in Claude
Code misses part of it and which is not compared.

## Security

No sign-in: the server binds 127.0.0.1, answers only to `ALLOWED_HOSTS`, and refuses writes
from a foreign `Origin`. The runner authenticates with `RUNNER_KEY`; each `claude` process gets
a run token limited to its run, retired five minutes after the process exits. Runner credentials
are checked before a request's body is read. The guard denies `rm -rf`, `git push`,
`git reset --hard`, `.env` files, paths outside the worktree, new migrations, in Build any file
the run has not allowed, and — once the run is paused — every tool.

## Error translation

The kit's error shape and codes. A move the table refuses, or a stale one, is `409 conflict`;
a spec that does not lint, or a field that fails a check, is `400 validation_error` with
`details`. The web app never shows `message`: `web/src/errors.ts` reads the code and the field,
and each page words the problem itself. A pull request whose files GitHub does not list answers
`{ files: null }`, not an error.

## Resilience

When PostgreSQL ends the server's connections — a restart — the listening connection reconnects
with backoff and listens again, and browsers are told to refetch (`resync`); the query pool
discards the connections it lost. The server stays up.

## Accessibility

The web app targets WCAG 2.2 AA. Its widgets are the zellige kit's: the card is a modal side
`Dialog`, its sections are `Tabs`. Every drag has a button in the card's dialog — Move up, Move
down, Mark done. Each page and the open card keep a status region mounted and write outcomes into
it; the card announces its own changes of state, the board nothing the runner does. Route changes
focus the new page's `h1`; closing a card returns focus to its link.

The Approvals tab, which a card waiting on a question opens on, holds the question, its options as
a `fieldset` named by the question — the recommended one's name ends "(recommended)", an option's
impact is its description — and a field for an answer in words. Answering, Resume and Cancel move
focus to the card's state line before their controls go; an empty answer marks its field invalid
and focuses it. A question's context is shown as plain text. The header's count of waiting
questions is text, not announced. `tests/ui/` scans every state it reaches with axe-core and
drives the board, the card and an answer by keyboard alone.
