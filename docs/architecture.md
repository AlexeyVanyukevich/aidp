# Architecture

What the board does today. This document is authoritative; the specs in
`docs/superpowers/specs/` are decision records and say why, not what.

## The parts

| Part     | Where         | What it does                                                                                                                                                                                                    |
| -------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server   | `server/`     | One Fastify process on 127.0.0.1: the REST API under `/api`, the board MCP server at `/mcp`, server-sent events at `/api/stream`, the PR poller, the sweeper, and the built web app                             |
| Runner   | `runner/`     | `board-cli daemon` claims work and carries a run out in stages — a spec run's or a delivery run's — each phase one Claude Code session; `board-cli event` and `board-cli guard` are the hooks its processes run |
| Web      | `web/`        | The board, the card and its tabs, on the zellige component kit; built into `server/public/`                                                                                                                     |
| Database | PostgreSQL 16 | Every record; `LISTEN/NOTIFY` on channel `board` carries change notices                                                                                                                                         |

## A task's life

Backlog → (Draft spec, or the owner saves a spec) → Spec draft → Spec review → (Approve) → Ready
→ (the runner claims) → Running → Review → (the pull request merges, or the owner marks it done)
→ Done.

- Backlog → Spec draft on **Draft spec**, which needs a description; Spec review → Spec draft on
  **Redraft**, which needs a note. Spec draft → Spec review when the spec run ends having saved a
  version. A spec run that fails, saves nothing or is cancelled sends its card back where it came
  from: Spec review if the task has a version, Backlog if not.
- Running or Spec draft → Needs approval when an agent asks, or the plan gate stops a plan its
  planner was not confident of; Needs approval → Running, or Spec draft for a spec run, when the
  owner answers.
- Running or Spec draft → Blocked when the runner is lost, a `git` or `gh` step fails, or the
  daemon is stopped; Needs approval → Blocked when a question waits 48 hours. Blocked → Running,
  or Spec draft, on Resume, or — for an expired question — on its answer.
- Running → Failed when a phase fails, Verify fails three times, or the owner cancels; Ready,
  Needs approval and Blocked → Failed on Cancel of a delivery run. Failed → Ready on Re-run,
  which has two choices (below).

Every move goes through `server/src/modules/tasks/transitions.ts`, a pure table; nothing else
writes `tasks.state`. Where a destination depends on the latest run's kind or on whether the task
has a spec, the caller reads those facts (`moveFacts`) and the table picks the state. The
description can change only in Backlog and Spec review.

## Linked projects

A project can link to the projects it references, so the agents of its runs can read their code.
A link goes one way: AIDP → ZLC says nothing about ZLC → AIDP. It lives in `project_links`
(`project_id`, `linked_project_id`, `note`, `created_at`; primary key the pair; a check refuses a
project linking to itself; both keys cascade on delete, so deleting a project removes every link
from or to it and nothing else). `GET /api/projects` returns each project with `links`, ordered by
key, each carrying `key`, `name` and `note`. `POST /api/projects/:key/links` with
`{ target, note }` answers 201, or `400 validation_error` on `target` (itself, unknown, already
linked) or on `note` (blank, over 500 characters); an unknown `:key` is 404.
`DELETE /api/projects/:key/links/:target` answers 204, or 404 for a link that does not exist. A
note is changed by removing the link and adding it again.

The Projects page lists each project's links — key, name, note, and a "Remove link to <KEY>"
button — above an Add a link form: a `Select` of every other project not yet linked, a required
Note field, and Add link. An empty or too-long note, or a refused target, marks its field invalid
and focuses it; the page's status region announces "<KEY> now links to <TARGET>." and "<KEY> no
longer links to <TARGET>.". After a removal focus moves to the form's `Select`.

A claim's work, for a start or a resume of either kind of run, carries `links`: the projects the
task's project links to, with `key`, `name`, `note`, `repo_path`, `github_repo` and `base_branch`.
In `prepare`, both kinds of run run `git fetch origin <base>` in each linked `repo_path` and make
a detached worktree of `origin/<base>` at `~/.aidp/worktrees/<run>-linked/<KEY>`, outside the run's
own worktree, so it never shows in its status or diff. The checkouts, with the note and the
checkout path, are written to `linked.json` in the run directory; the run's links are fixed
there, and a failed fetch or worktree blocks the run as `step_failed`. A run that ends with any
outcome but `released` removes each checkout and then the `<run>-linked` directory, and so does a
cleanup claimed after a Cancel; a paused run keeps them. A resume past `prepare` makes any
checkout that is missing again, fetching only for that (`runner/src/linked.ts`).

Every `claude` process of every phase, first or resumed, gets one `--add-dir <checkout>` per
checkout in `linked.json`, which is how Claude Code lets it read outside its worktree. The handoff
then carries a `<linked_projects>` element, ordered by key, with one `<project key name
github_repo base_branch path>` per checkout and the escaped note as its text, and its
`<constraints>` line says the linked checkouts may be read and never changed. With no links the
handoff is as before. Pushing and the pull request use only the task's own project; nothing
commits, pushes or opens a pull request in a linked repository.

## A spec run

**Draft spec** queues a spec run; **Redraft** queues one carrying the latest version and the
owner's note. Spec runs and delivery runs are numbered apart: "Draft 2", "Run 1", and the
delivery branch `board/<KEY>-r<n>` counts delivery runs only. Claiming a spec run moves no card,
and one whose card has left Spec draft is cancelled at claim.

The runner (`runner/src/drafting.ts`) checks out a detached worktree of `origin/<base>` — no
branch, nothing is pushed — then runs one phase, `spec`: the spec-writer on Opus at high effort,
with Read, Grep, Glob and the board's `get_task`, `get_spec`, `save_spec`, `log_step` and
`request_approval`. Its handoff carries the task's description, and for a redraft the version and
the note. Its instructions carry the Spec tab's template word for word and tell it to ask every
open question in one batch. The phase pauses, blocks and resumes like any other.

`save_spec` is refused outside a spec run. A run's first save inserts the next version, linked
to the run and superseding earlier drafts; its later saves rewrite that version. It answers with
the lint in the Spec tab's words (`server/src/modules/specs/spec-lint-text.ts`), and moves no
card. `get_spec` in a spec run returns the latest version.

The runner ends a spec run whose phase succeeded with `run_end` `drafted`; the server moves the
card to Spec review if the run saved a version, and otherwise fails the run with "the
spec-writer saved no spec". The card's view carries a failed draft's reason until the next run.

## A delivery run

The runner creates a worktree under `~/.aidp/worktrees/<run>` on `board/<KEY>-r<n>` from
`origin/<base>`, and a run directory under `~/.aidp/runs/<run>` holding the agents, the
hooks, the MCP configuration, the event buffer and the files Build may change. A run goes through
stages — `prepare`, `plan`, `build`, `tests`, `verify`, `push`, `pr` — with up to three Build →
tests → Verify rounds. All criteria passing pushes the branch and opens the pull request, or
takes one already open for the branch. The worktree is removed when the run ends.

**The setup command.** A project may carry a `setup_command` (at most 500 characters), set when
it is registered or later with `PATCH /api/projects/:key`, whose body is exactly
`{ "setup_command": string | null }`: any other field is refused with 400, a null or blank value
clears it, and an unknown key answers 404. Like the test command, a command whose first word does
not resolve in `repo_path` is refused with `validation_error` on the field. In the `prepare`
stage of every spec run and delivery run, once the worktree is checked out, the runner runs it
with `sh -c` in the worktree, bounded by `TEST_TIMEOUT_MS`, before any phase starts: it is how
the repository's dependencies — and so the `charter` rules `CLAUDE.md` imports — are there when
the agents' sessions begin. It is reported as a `tool_call` event named `setup_command`, with the
test command's payload (exit code, timeout, the end of the output). A null command runs nothing.
One that exits non-zero or times out blocks the run as `step_failed`, carrying the command and
the last 4,096 characters of its output; the checkpoint stays in `prepare`, and Resume recreates
the worktree and runs the command again.

The run's `settings.json` sets Claude Code's `attribution` to `{ "commit": "", "pr": "" }`, so
the runs' commits and pull requests carry no `Co-Authored-By` trailer or generated-by line.

The stage machinery — checkpoints, blocks, one process of a phase, the end of a run — is shared
by both kinds of run, in `runner/src/run-steps.ts`.

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

**A batch.** `request_approval` with kind `questions` asks up to eight questions together, each
with up to five options and a recommendation; the server numbers them `q1` … `qn` and writes a
lead line when the agent gave none. It is answered whole: every question needs an option, words,
or both, or the answer is refused naming `answers[<i>]`. The resume message lists each question
with its answer. The header counts a batch's questions, not the batch.

**The plan gate.** A plan not marked `confidence: high` stops at the end of the planner's process:
the runner raises a `plan` approval with the plan as its context, inside the still-open Plan
phase. Approve plan ends the phase and starts Build; an answer in words resumes the planner's
session, and its revised plan meets the gate again. A plan's rendered text is limited to 20,000
characters, the most a `plan` approval's `context_md` holds: `save_plan` refuses a longer plan,
whatever its confidence, and asks the planner to shorten it. If the board refuses the gate's
request with a 4xx answer, the run fails with a sentence naming the field and the problem.

**Re-run.** A Failed card offers two choices, both the `rerun` move (Failed → Ready) with the
latest approved spec. `POST /api/tasks/:id/actions/rerun` takes an optional body
`{ "plan": "keep" | "again" }`; no body means `again`, `keep` with no plan to keep answers
`409 conflict` and moves nothing, and any other value answers `400 validation_error` naming
`plan`.

- **Re-run and plan again** queues a run whose planner is handed the earlier plans. The
  handoff carries the newest plan any earlier delivery run saved on the same spec version in a
  `<previous_plan run="<n>" accepted="yes|no">` tag; when that plan was not accepted and an older
  accepted one exists on the same version, both are carried, the newer first. Each holds the
  plan's rendered text (at most 20,000 characters), escaped like the other tags, and is separate
  from the `<plan>` tag Build and Verify get. The planner's instructions call a previous plan a
  starting point to check against the spec and the code and to revise, never to carry out, and
  say `accepted="no"` was never approved. Its new plan meets the plan gate like any plan. With no
  earlier plan on that version the handoff is unchanged.
- **Re-run with this plan** is offered, as the primary button, only when the task has a plan to
  keep; the task view reports it as `plan_to_keep: { run }`. In one transaction the run is queued
  and the plan to keep is copied into it as its own `plan` artifact, with the same `body_md` and
  `data` and the number of the source run in `artifacts.copied_from_run`; the source artifact is
  untouched. The Plan tab marks it "Kept from run <n>", and the run's Timeline lists it under
  Runner.

A plan is **accepted** when its confidence is `high`, when it is a copied plan, or when the owner
chose Approve plan on a `plan` approval of the same run whose context equals the plan's text
exactly. Only the text ties an approval to a plan; neither the phase nor the time does, and
whether Build ever started does not matter. The plan to keep is the newest accepted plan of any
earlier delivery run whose spec version equals the new run's. A Failed card cannot change its
spec, so every run since the approval carries the same version.

A run holding a copied plan starts no planner: it has no Plan phase and raises no plan gate, and
after `prepare` it goes to Build, whose allowed files are the copied plan's. Its checkpoints name
the copied plan, and a resume from any stage before Build goes on to Build with it. The claim
tells the runner (`kept_plan`); it also carries `previous_plans` for a planner starting again,
which a run holding a copied plan leaves empty. Out-of-plan allowances and migration approvals
belong to the run that got them: a new run asks again. The kept plan is used as written and is
not checked against changes to the base branch since it was written; the new worktree is cut
from the current `origin/<base>`, and Build and Verify meet any drift as in any run.

**Out-of-plan edits.** In Build the guard refuses a file outside the run's allowed list and tells
the builder to ask with `request_approval` kind `out_of_plan`. Allowing the change adds the files
to the allowed list for the rest of the run.

**Migration approval.** A migration is a file under a `migrations/` directory whose name does not
start with `index.`; the registry (`index.*`) is an ordinary file, held to the plan alone. In
Build the guard refuses to create one, or to change one already in the worktree, even when the
plan or an `out_of_plan` answer lists it, and tells the builder to ask with `request_approval`
kind `migration`: the path in `files`, a summary in `question` (what it changes, and whether its
down step undoes it), and the whole file in `context_md` (up to 20,000 characters; `plan` approvals hold 20,000 too, `question`, `out_of_plan` and
`questions` 8,000). The request offers `allow` and `refuse` and pauses the run as an `out_of_plan` one does.
The Approvals tab shows the summary, the path, and the file as plain text in a monospace block.
Allowing adds the path to the run's approved migrations and its allowed files for the rest of
the run; the claim carries both, and the runner writes `approved-migrations.json` beside
`allowed-files.json`, where the guard reads it. Outside Build the guard still refuses to create
a migration.

**Migrations on start.** `server/src/server.ts` applies every pending migration before it
listens. A failed one is logged by name with the database's error, the server exits non-zero
without listening, and the migration is not recorded as applied. `npm run migrate` (and
`./run migrate`) applies them without starting the server and fails the same way.

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

New migrations, and changes to migrations from the base branch, need the owner's approval.

No sign-in: the server binds 127.0.0.1, answers only to `ALLOWED_HOSTS`, and refuses writes
from a foreign `Origin`. The runner authenticates with `RUNNER_KEY`; each `claude` process gets
a run token limited to its run, retired five minutes after the process exits. Runner credentials
are checked before a request's body is read. The guard denies `rm -rf`, `git push`,
`git reset --hard`, `.env` files, paths outside the worktree, in Build any file the run has not allowed, `Bash` or `Agent` sent to the background (`run_in_background: true`,
which a `-p` process loses when its turn ends), and — once the run is paused — every tool. In every phase it also denies `git commit` with
`--no-verify` or `-n` (alone or inside a cluster such as `-an`), and `git -c core.hooksPath=…
commit`, with a reason saying the commit-msg hook must not be skipped; text inside a `-m` value
never matches.

The guard reads `linked.json`. Edit, Write, MultiEdit and NotebookEdit on a path inside a linked
checkout or a linked project's `repo_path` are refused, naming the project's key and saying linked
repositories are read-only. Read, Grep and Glob are allowed inside a checkout; on a linked
`repo_path` they are refused with a reason pointing to the checkout, as is a `Bash` command that
contains a linked `repo_path`. A `Bash` command naming only the checkout is allowed: a write
through `Bash` into a checkout is not caught, and the checkout is thrown away when the run ends.
Other paths outside the worktree are refused by the file tools as before.

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
it; the card announces its own changes of state, the board nothing the runner does. The Projects page
writes link changes into its status region. Route changes
focus the new page's `h1`; closing a card returns focus to its link.

The Approvals tab, which a card waiting on a question opens on, holds the question, its options as
a `fieldset` named by the question — the recommended one's name ends "(recommended)", an option's
impact is its description — and a field for an answer in words. Answering, Resume and Cancel move
focus to the card's state line before their controls go; an empty answer marks its field invalid
and focuses it. A question's context is shown as plain text. The header's count of waiting
questions is text, not announced.

A batch is one form: per question a `section` under an `h4`, "Question <i> of <n>", holding the
kit's `RadioGroup` named by the question when it has options, and a field "Your answer to
question <i>"; then one Send answers. Choosing sends nothing. A send with questions unanswered
marks each — the radio group when it has options, so the radio that takes focus is described by
the error, else the field — and focuses the first: its first radio, or its field.

The Spec tab opens on the task's Description, with Save description, in Backlog and Spec review;
Draft spec sits beside Approve in Backlog, and What to change with Redraft below the editor in
Spec review; in Spec draft the editor is read-only and says so. An empty description or note
marks its field invalid and focuses it. The card announces a draft ready to review with its
version, read afresh, and a draft that did not finish with its reason, which also stands under
its state line. `tests/ui/` scans every state it reaches with axe-core and drives the board, the
card, an answer and a batch by keyboard alone.
