# Slice 2 — pause and resume

Status: **approved**, 2026-10-20; designed 2026-10-19. Builds on slice 1 as
[docs/architecture.md](../../architecture.md) describes it on that date.

> **This is a decision record, not a description of the system.**
>
> It states what was decided on 2026-10-19, before any of it was built. It is not revised as
> the code moves on.
>
> Read it to learn **why** something has the shape it does. For **what** the system does today,
> read [docs/architecture.md](../../architecture.md). Where the two disagree, the architecture
> document is right and this one is stale.

The [MVP design](2026-10-10-mvp-design.md) is this document's source: §13 names slice 2, and
§5, §6 and §8 hold most of what it builds. This document records what the MVP design left open,
every place it departs from it, and what was measured before design began. Anything the MVP
design specifies for slice 2 and this one does not mention holds as written there.

Throughout, as in the MVP design: **the owner** is the board's one user; **the runner** is the
`board-cli daemon` process; **a target repository** is one the board carries tasks out in. And:

- **a pause** is a run stopped on an approval request, waiting for the owner's answer;
- **a block** is a run stopped by something other than a question: a lost runner, a failed
  `git` or `gh` step, an approval left unanswered, or the runner being stopped;
- **a process** is one `claude -p` launch; **a session** is the Claude Code conversation that
  one or more processes carry, by `--session-id` and then `--resume`.

---

## 1. Purpose

At the end of this slice, a run that cannot decide something stops spending, puts the question
on its card, and continues from the owner's answer in the same Claude Code session, with its
context intact. A run interrupted by anything else waits in Blocked and continues from where it
stopped when the owner presses Resume.

The MVP's exit gate (MVP design §1) asks for at least one of its ten real tasks to pause on an
approval and resume correctly. Until this slice ships, that part of the gate cannot be passed.

## 2. Decisions taken while scoping

Taken with the owner on 2026-10-19.

| Question                                                       | Decision                                                                                                       | Why                                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| An approval unanswered for 48 hours blocks the card; then what | The question stays answerable on the Blocked card, and answering resumes the run. Resume is not offered for it | Continuing without the answer would let the agent decide the question itself; it is never auto-approved |
| Can a paused or blocked run be cancelled                       | Yes: Cancel moves Needs approval and Blocked to Failed, as it does Ready and Running                           | Otherwise a card the owner has given up on can leave Blocked only through Resume                        |
| Which backlog entries the slice takes                          | The lost-runner sweeper, the PostgreSQL restart crash, the 400-before-401 on runner routes, the PR tab's 500   | The first three touch the code this slice changes; the fourth is small and the owner asked for it       |

### Departures from the MVP design

| MVP design                                                                      | This slice                                                                                                                           | Reason                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cancel from Spec draft or Running (§5)                                          | Also from Needs approval and Blocked                                                                                                 | §2 above                                                                                                                                                         |
| Blocked → Running by Resume, in every case (§5)                                 | An approval-expired block continues by answering the question, not by Resume                                                         | §2 above                                                                                                                                                         |
| The server stores the checkpoint when `request_approval` is called (§6)         | The runner writes checkpoints, at every stage of the run; the approval row keeps phase, attempt and session                          | Only the runner knows the worktree's HEAD, and a lost runner needs a checkpoint that no approval wrote                                                           |
| The runner waits up to 60 s for the process to exit, then kills it (§6)         | The `PostToolUse` hook marks the run directory paused; from then the guard refuses every tool, and the runner gives the process 60 s | §3: hooks see MCP calls and the guard can refuse them, so the pause takes effect at once, through Claude Code's documented hook interface rather than its stream |
| One `phases` row per attempt (§4)                                               | One `phases` row per attempt, **and** per session: a pause and a resume happen inside one phase row                                  | §3: Claude Code reports a resumed session's usage cumulatively, so the phase is the unit that reconciles                                                         |
| Every phase of the ten exit-gate tasks within 2% of Claude Code's cost (§1, §4) | A phase one of whose processes was stopped by a signal is marked **interrupted**, and is not held to the 2%                          | §3: a killed process's usage is missing from Claude Code's own totals, so its figure is not comparable; the board's counters still are                           |
| Plan answered → "the revised plan goes through the same check" (§6)             | The plan gate sits inside the Plan phase: the phase ends only once its plan is accepted                                              | Keeps one session per phase row; a revised plan is the same planner session continued                                                                            |
| Stopping the daemon fails its run (slice 1)                                     | Stopping the daemon blocks its run, with the reason "runner stopped"; Resume continues it                                            | Pause and resume make an interrupted run recoverable; failing it throws that away                                                                                |
| `GET /runs/{id}/files` answers the list, or 500 when `gh` fails                 | It answers `{ files: [...] }`, or `{ files: null }` when GitHub did not list them                                                    | The backlog entry: an expected outside failure is not an internal error                                                                                          |

## 3. Measured before design

Recorded on 2026-10-19 with Claude Code **2.1.287** (slice 1 checked its flags against 2.1.212),
signed in with a claude.ai subscription, in a scratch repository, against a stand-in board MCP
server whose `request_approval` answers as §5's does. `sonnet` resolved to `claude-sonnet-5-5`
and `haiku` to `claude-haiku-4-5-20251001`; the board has a price row for each.

### A pause and a resume

Two pairs of processes, each pair one session: Haiku with the fewest flags that work, then
Sonnet with the runner's whole call — `--agents`, `--agent`, `--effort`, `--permission-mode`,
`--allowedTools`, `--settings` with hooks, `--setting-sources project` — repeated on the resume.

| Model  | Process                     | `message_delta` output | Final `modelUsage` output | Final `costUSD`              |
| ------ | --------------------------- | ---------------------- | ------------------------- | ---------------------------- |
| Haiku  | 1: asked, then stopped      | 530                    | 541                       | $0.0295                      |
| Haiku  | 2: resumed with the answer  | 44                     | **585**                   | **$0.0330**                  |
| Sonnet | 1: a note, asked, stopped   | 202                    | 202                       | $0.0094, and Haiku's $0.0010 |
| Sonnet | 2: resumed, a note, a reply | 84                     | **286**                   | **$0.0120**, and $0.0010     |

1. **A resumed process's `modelUsage` and `costUSD` are cumulative over the session**, per
   model. The resumed totals are the first process's plus the second's own: 541 and 44 make
   585; 202 and 84 make 286. Claude Code's own Haiku call in Sonnet's first process, 11 output
   tokens, reappears unchanged in the second's totals, though the second made none. Slice 1
   records a process's remainder as its `modelUsage` less what its stream attributed; applied
   to a resumed process, that counts the earlier processes again.
2. **A resumed stream does not replay earlier messages**: only new message ids. Per-message
   usage events stay exact as they are.
3. **`--resume <id>` keeps the session id**; `--fork-session` is what would change it.
4. **The role survives a resume that repeats the call's flags**: the resumed Sonnet process kept
   its role's instruction (its reply ended with the word the role's prompt asked for), its two
   tools and its model.
5. **Both models stopped when the tool told them to**, with a `success` result. Sonnet did so
   even when its prompt told it to call another tool afterwards: it put that off until the
   answer.
6. **Hooks see MCP calls.** `PreToolUse` and `PostToolUse` fire for `mcp__board__*` tools,
   carrying the tool's input and its response. A `PreToolUse` denial of an MCP tool reaches the
   model as an error, and the tool does not run. The model may still say it ran: the board
   trusts what its tools recorded, never what an agent reports.

### A process killed partway through a reply

Sonnet, told to make three `note` calls and then write a story. It made the calls in one
message; the signal went 30 text chunks into the second. Each session was then resumed with
"You were interrupted."

| Signal    | What the stopped process wrote                                                       | What the resumed totals carried over                     |
| --------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `SIGTERM` | The rest of the message it had, and a `success` result counting 828 output; exit 143 | 217 output — the first message only — and the Haiku call |
| `SIGKILL` | The second message's `message_start`, then nothing: no `message_delta`, no result    | Nothing: the totals were the resumed process's own       |

7. **Claude Code's saved totals miss a stopped process's usage**: all of it after `SIGKILL`,
   part of it after `SIGTERM`. After either, the session's totals are no longer the sum of its
   processes, and Claude Code's `costUSD` for it is too low.
8. **Both sessions resumed.** A session whose first message completed survives its process
   being killed.
9. **A message can arrive whole.** The second message's `message_start` already carried its
   final output count, 611 there and in its `message_delta` (slice 1 found `message_start`
   carrying the count as streaming began, 4 for the first message here). A message cut off
   before its `message_delta` therefore has its `message_start` count as a floor.
10. **A session that no longer exists** — Claude Code deletes sessions after 30 days by default
    — fails a resume with exit 1, "No conversation found with session ID: <id>" on stderr, and
    an `error_during_execution` result of no turns and no cost.

### Stopped at other points

Recorded on 2026-10-20, the same way, each case twice. **A session's first process, stopped
before its first message completed**, then resumed:

| Stopped                            | Signal    | Resumed?                                | What the resumed totals carried over |
| ---------------------------------- | --------- | --------------------------------------- | ------------------------------------ |
| Right after its `init` line        | `SIGTERM` | Yes, 2 of 2                             | Nothing                              |
| Right after its `init` line        | `SIGKILL` | **No**, 2 of 2: "No conversation found" | —                                    |
| 5 text chunks into its first reply | `SIGTERM` | Yes, 2 of 2; no result was written      | Claude Code's own Haiku call only    |
| 5 text chunks into its first reply | `SIGKILL` | Yes, 2 of 2                             | Nothing                              |

**A session's second process, stopped after a first one paused and ended by itself**, then
resumed:

| Stopped                              | Signal    | What the resumed totals carried over, 2 of 2                                   |
| ------------------------------------ | --------- | ------------------------------------------------------------------------------ |
| 30 text chunks into its second reply | `SIGKILL` | Exactly the first process's totals                                             |
| Right after its `init` line          | `SIGKILL` | Exactly the first process's totals                                             |
| 30 text chunks into its second reply | `SIGTERM` | Part of the second's: 400 of the 986 output its own result counted; 358 of 951 |

11. **Claude Code keeps a session's totals as records in the session's file**, written as a
    process goes and when it exits. They are what a resume starts from: `SIGKILL` loses what the
    stopped process had not yet written, and the totals fall back to the last ones written —
    the earlier process's, or nothing.
12. **A session killed before it wrote its first message cannot be resumed** — its file holds
    one settings line — and its id cannot be used again: `--session-id` with it answers
    "Session ID <id> is already in use." `SIGTERM` at the same moment writes the prompt first,
    and the session resumes.
13. **`SIGTERM` writes a result only sometimes**: after a message that arrived whole (fact 9),
    not partway through one that was streaming.
14. **§7's rule, replayed over all eighteen recorded sequences** — the four of the earlier
    tables and the fourteen here: on the two pause-and-resume pairs, the board's totals equal
    Claude Code's exactly; in every sequence, Claude Code's own calls are counted exactly once,
    matching its own count of them; on every stopped sequence, the board's totals exceed Claude
    Code's by the stopped process's messages, which its stream recorded and Claude Code's saved
    totals lost (fact 11). That excess is real usage, not usage counted twice.

`runner/scripts/record-stream.sh` gains these recordings — the pauses and resumes, and each kind
of stopped process with its resume — so the fixtures the tests use come from the script, as
slice 1's do.

## 4. Task lifecycle

The transition table (`server/src/modules/tasks/transitions.ts`) gains these moves. Every
other row stays as slice 1 built it.

| Move               | From → To                                          | Actor                                                                   | Guard, in the service                                                                 |
| ------------------ | -------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `request_approval` | Running → Needs approval                           | MCP `request_approval`, or the runner's plan gate                       | A phase of the run is running (MCP); the plan is saved (gate); no other open approval |
| `answer`           | Needs approval or Blocked → Running                | Owner answers                                                           | The approval is open, or expired and the cause of the block                           |
| `expire`           | Needs approval → Blocked                           | Sweeper                                                                 | The approval has been open for 48 hours                                               |
| `block`            | Running → Blocked                                  | Sweeper (runner lost), or the runner (a step failed, or it was stopped) | —                                                                                     |
| `resume`           | Blocked → Running                                  | Owner: **Resume**                                                       | The run has a checkpoint, and its block is not an expired approval                    |
| `cancel`           | Ready, Running, Needs approval or Blocked → Failed | Owner: **Cancel**                                                       | —                                                                                     |

Spec draft's rows in the MVP design's table — a spec run asking a question — arrive with slice 3.

**Run statuses** gain `paused` and `blocked`. A run is `queued` again while a resume waits for
the runner, and `running` once claimed. **Phase statuses** gain `paused`. **Approval statuses**
gain `withdrawn`, for an open approval whose run was cancelled.

A move refused by the table, or an answer to an approval already answered, is `409 conflict`:
the client's view was stale. The `resume` guard failing on an expired approval is also
`409 conflict`, since the web app never offers Resume there and a request for it means the view
was out of date.

## 5. Approvals

### Kinds and payload

The platform design's payload, cut to three kinds:

| Kind          | Raised by                             | Options                                                                      |
| ------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| `question`    | Any phase's agent                     | The agent's, zero to five; free text is always possible                      |
| `out_of_plan` | The builder, after the guard's denial | Fixed by the server: `allow` "Allow the change", `refuse` "Keep to the plan" |
| `plan`        | The runner's plan gate                | Fixed: `approve` "Approve plan"; free text asks for changes                  |

An approval row holds: kind, question (at most 1,000 characters), options as
`{ id, label, impact? }` (label at most 200, impact at most 500), an optional recommendation
naming one option's id, context in Markdown (at most 8,000), the files an `out_of_plan`
approval asks for (1 to 20 paths relative to the worktree), the phase, attempt and session it
paused, and, once answered, `{ option_id?, text? }` with its time.

### `request_approval`, the MCP tool

Takes `kind` (`question` or `out_of_plan`, default `question`), `question`, `options`,
`recommendation`, `context_md` and `files`, checked as above. Refused, with the reason as the
tool's error, when no phase of the run is running, when the run already has an open approval,
or when the recommendation names no option.

Accepted, in one transaction: the approval row; an `approval_requested` event on the running
phase; the phase to `paused`; the run to `paused`; the card through `request_approval`; and the
notices `task.updated` and `approval.requested`. The tool answers:

> Paused: the owner will answer on the board, and the answer will arrive as your next message.
> End your turn now.

### The plan gate

After the planner's process ends with a saved plan, the runner reads its confidence. `high`
ends the Plan phase and starts Build. Anything else raises a `plan` approval, through an
`approval_requested` event the runner sends with a client-generated approval id, so a replayed
event opens it once. The approval's context is the plan as the Plan tab renders it.

**Approve plan** ends the Plan phase and starts Build. A free-text answer resumes the planner's
session with it; the planner saves a revised plan, and the gate reads the revised plan's
confidence in turn. The Plan phase stays one phase row and one session throughout.

### Out-of-plan edits

In Build, the guard still denies an edit to a file the run has not allowed, now with the reason:

> `<path>` is not in the plan. If the work needs it, call request_approval with kind
> out_of_plan, the files, and why. Then end your turn.

**Allow the change** adds the files to the run's allowed list, for the rest of the run, later
attempts included, and resumes the builder with "The owner allowed changes to: `<files>`."
**Keep to the plan** resumes it with "The owner kept to the plan. Do not change: `<files>`."
followed by the owner's text when there is one. The allowed list is the plan's files plus every
file an answered `out_of_plan` approval allowed; the server computes it, and the runner writes
it to the run directory before resuming.

### Answering

`POST /api/approvals/{id}/answer` with `{ option_id?, text? }`, at least one of the two, text at
most 4,000 characters. An `option_id` the approval does not offer is `400 validation_error` on
the field `option_id`; an approval that is not open, and not the expired cause of its card's
block, is `409 conflict`.

In one transaction: the answer and `answered` status; an `approval_answered` event; the card
through `answer`; the run `queued` with a resume pending, and its resume message; the notices
`task.updated`, `approval.answered` and `run.queued`, which wakes a waiting claim.

The resume message is built from the answer: the chosen option's label and impact, then the
owner's text, under "The owner answered your question:" — or the kind's own wording above.

### Expiry

An approval open for 48 hours becomes `expired`: the run `blocked`, the card through `expire`.
It is never auto-approved. The question stays answerable on the Blocked card, and an answer
resumes the run exactly as it would have from Needs approval.

## 6. Checkpoints and resume

### What a checkpoint holds

The runner sends a `checkpoint` event as each **stage** of a run begins, and whenever a process
of the stage ends; the server keeps the latest on the run. A checkpoint holds the stage, the
attempt, the phase and session when the stage is a phase, the session's last reported totals
(§7), the worktree's HEAD, and the ids of the plan and of the last failing verify report. The stages are `prepare` (fetch and worktree), `plan`, `build`, `tests`, `verify`,
`push` and `pr`.

### A pause, from the runner's side

1. The agent calls `request_approval`; the server pauses the run.
2. The `PostToolUse` hook, `board-cli event`, sees the call succeed and writes a `paused` marker
   into the run directory. From then the guard refuses every tool with "The run is paused; end
   your turn." — MCP tools included (§3, fact 6).
3. The runner sees the marker and gives the process 60 seconds to exit, then ends it. The model
   is expected to stop on its own (§3, fact 5); the guard keeps one that does not from changing
   anything meanwhile. The heartbeat's answer also names the run in `pause`, a backstop for a
   marker that was never written: the runner treats it the same way.
4. When the process has exited, the runner sends the process's closing usage (§7) and a
   checkpoint, retires the run token, and **releases the run**: no `phase_end`, no `run_end`,
   no heartbeat for it. The worktree stays as it is, uncommitted edits included.
5. The runner goes back to claiming. A paused run holds no process and no slot, so the runner
   can carry out other runs meanwhile.

A resume removes the marker before the process starts.

**Ending a process**, here and whenever the runner stops one — a cancel, a stopped daemon — is
`SIGTERM`, then `SIGKILL` if it is still running 10 seconds later. `SIGTERM` lets Claude Code
finish the message it has and write its result (§3, the stopped processes).

### Claiming a resume

`POST /runner/claim` returns one of three kinds of work, oldest first:

- `start`, as in slice 1;
- `resume`: the run, its checkpoint, the resume message, and the run's allowed files;
- `cleanup`: a cancelled run whose worktree is still on disk (§8).

On `resume`, the runner checks the worktree is there on the run's branch. A worktree that is
gone fails the run with the reason "the run's worktree is gone". A session that is gone —
`claude --resume` answering as §3's fact 10 describes — is one of two things:

- **It held no message**: its process was killed before writing one (§3, fact 12). Nothing is
  lost. The runner starts the phase again in the same phase row, with the phase's own handoff
  and a new session id, which the phase row then records; the new session's baseline is zero.
- **It held messages**: Claude Code deleted it, after 30 days. The run fails with "the run's
  Claude Code session is gone; Re-run starts again from Plan".

The runner tells the two apart by the phase's recorded events: a phase with no `message` event
held none. Otherwise it continues from the checkpoint's stage:

| Stage                     | Resume                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `plan`, `build`, `verify` | `claude -p --resume <session> "<message>"` with the phase's flags, in the same phase row    |
| `plan` after the gate     | Approve plan: the phase ends and Build starts. Text: as the row above                       |
| `tests`                   | The test command runs again                                                                 |
| `prepare`, `push`         | The step runs again                                                                         |
| `pr`                      | `gh pr view --head <branch>` first; a pull request already open is taken, not created twice |

From there the run goes on as in slice 1: the same Build → tests → Verify rounds, the same three
attempts, the same push and pull request.

The resumed process's `phase_start` repeats the phase's id with `resumed: true`, which sets the
phase back to `running`. The message for a block is "You were interrupted. Continue from where
you stopped."

### A process outliving its runner

The runner writes each process's pid into the run directory. A resume first ends a process
still alive under that pid, so two processes never write to one session.

## 7. Usage and cost across a resume

A phase row is one session (§2's departures), so the phase is where Claude Code's own figures
and the board's reconcile.

- **Per-message events** stay as they are; a resumed stream does not repeat old messages (§3,
  fact 2).
- **A message cut off** — its process ended before the message's `message_delta` — is recorded
  from its `message_start`, marked `cut`, its output count a floor (§3, fact 9). Slice 1 drops
  it.
- **The remainder**, Claude Code's own calls. Each process's result reports the session's totals
  so far; the runner keeps the last ones it saw in the checkpoint, as the session's **baseline**,
  zero before the session's first result. A process's remainder, per model and counter, is its
  final `modelUsage` less the baseline less what its own stream attributed, and never below
  zero. On a session whose processes all ended by themselves, the counters on the card sum to
  exactly what Claude Code counted, as in slice 1. On every stopped process §3 recorded, the
  rule counts nothing twice (fact 14). Its one possible error, not seen in the recordings, is to
  drop a resumed process's own unattributed calls where Claude Code's saved totals lag, which
  only an interrupted phase can have.
- **Reported cost**: each process contributes its final `costUSD` less the baseline's; the
  phase's reported cost, on its `phase_end`, is their sum. For a phase whose processes all ended
  by themselves, that is the last process's `costUSD`, the session's total.
- **An interrupted phase** is one a process of which was ended by a signal — a cancel, a
  stopped daemon, a pause that outlived its 60 seconds — or lost with its runner. Its phase row
  says so. Claude Code's own figure for it misses what the stopped process counted (§3, fact 7),
  so the Cost tab does not compare it: in place of the drift flag it says "Not compared: a
  process of this phase was stopped, and Claude Code's own figure misses part of it." The exit
  gate's 2% applies to the phases that were not interrupted.

## 8. Blocks

| Cause               | Raised by                                                             | Shown on the card                                                    | Continued by |
| ------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------ |
| Runner lost         | Sweeper: no heartbeat for 90 seconds on a `running` run               | "The runner stopped sending heartbeats."                             | Resume       |
| A step failed       | The runner: a `git` or `gh` command exits non-zero                    | The command, and its output in a disclosure                          | Resume       |
| Runner stopped      | The runner, on SIGINT or SIGTERM: it ends the process and checkpoints | "The runner was stopped during <stage>."                             | Resume       |
| Approval unanswered | Sweeper: open for 48 hours                                            | "The question went unanswered for 48 hours. Answer it in Approvals." | Answering    |

A step failure and a stopped runner reach the server as an `error` event whose payload says
`blocks: true` and carries the cause; its effect blocks the run and moves the card through
`block`. In slice 1 a failed `git` or `gh` step failed the run; that interim rule ends here, as
MVP design §13 said it would.

**The sweeper** runs every 60 seconds with an injected clock. **A sweeper tick that follows a
gap longer than twice its interval only re-arms:** a laptop that slept stops the runner's
heartbeats and the server's clock-driven checks together, and on waking the runner deserves a
full 90 seconds to report before its runs count as lost. For the same reason **every request
the runner makes carries a timeout** — the claim's wait plus 10 seconds, 30 seconds for the
rest — so a connection left dead by a sleep fails and is retried instead of hanging the daemon.
Slice 1's requests have none.

A heartbeat for a run that is no longer the runner's to hold — blocked by the sweeper, or
cancelled — is answered with that run in `cancel`, so a runner that was wrongly declared lost
stops its process rather than racing a resume.

**Cancelling a paused or blocked run** moves the card to Failed, the run to `cancelled`, an
open approval to `withdrawn`, and queues `cleanup` work. The runner, on claiming it, removes the
worktree and sends the run's `run_end`, whose effect moves nothing, since the card has already
moved.

## 9. Server surface

**REST**, added or changed:

| Method | Path                             | Purpose                                                               |
| ------ | -------------------------------- | --------------------------------------------------------------------- |
| GET    | `/api/tasks/{id}/approvals`      | The task's approvals, newest first                                    |
| GET    | `/api/approvals?status=open`     | Open approvals across every project, with each task's key and project |
| POST   | `/api/approvals/{id}/answer`     | §5                                                                    |
| POST   | `/api/tasks/{id}/actions/resume` | §6; `cancel` widens as §4 says                                        |
| GET    | `/api/runs/{id}/files`           | Now `{ files }`, `files` being `null` when GitHub did not list them   |
| POST   | `/api/runner/claim`              | Returns `start`, `resume` or `cleanup` work                           |
| POST   | `/api/runner/heartbeat`          | Answers `{ cancel, pause }`                                           |

The task's card view gains its open or expired approval's id and kind, and the run's block.

**MCP**: `request_approval`, §5.

**Server-sent events** gain `approval.requested` and `approval.answered`, with the task's id;
and `resync`, sent after the server's listening connection reconnects, which tells the browser
to refetch everything, since notices sent while it was down are lost.

**Runner authentication.** The runner-key and run-token checks move from `preHandler` to
`preValidation`, so an unauthenticated request is refused before its body is read: every
authentication failure answers the same `401`, whatever the body.

**A PostgreSQL restart.** The listening connection reconnects with backoff — 1 second, doubling
to 30 — and listens again; a long-poll waiting on it times out as it would have. The query
pool gets an `error` listener too: today an idle pooled connection dropped by the database
also stops the server, through the same unhandled `error` the backlog entry describes.

## 10. Data model

One migration, `002_pause_and_resume`:

- `tasks`: no change.
- `runs`: `paused` and `blocked` statuses; `checkpoint` jsonb, the latest; `block` jsonb —
  cause, and for a failed step its command and output; `pending` — `resume` or `cleanup` or
  null; `resume_message` text.
- `phases`: `paused` status; `interrupted` boolean.
- `events`: none; a cut message's mark is in its payload.
- `approval_requests`: `withdrawn` status; `files` jsonb; an index on `(status, created_at)` for
  the sweeper and the header's count.

## 11. Web app

### What changes

- **The card** gains the **Approvals** tab, fourth: Spec, Plan, Timeline, Approvals, Cost, PR.
  A card opened in Needs approval, or blocked on an expired approval, opens on it.
- **The state line's actions** gain **Resume** on Blocked cards except an expired approval's,
  and **Cancel run** on Needs approval and Blocked cards.
- **A Blocked card** says why, under the state line, in the words of §8's table.
- **The board's cards** gain a badge, "Question waiting", on a card whose approval is open or
  expired; in the link's text it reads as words, like the rest of the card.
- **The header** counts open approvals across all projects, as text: "1 question waiting",
  "3 questions waiting", nothing at zero.
- **The Timeline** shows a request and its answer as markers in their phase's band, and a pause
  as a gap marked "Paused" with its length.
- **The Plan tab** says "Waiting for your approval in Approvals." while a `plan` approval is open.
- **The Cost tab** says, for an interrupted phase, "Not compared: a process of this phase was
  stopped, and Claude Code's own figure misses part of it." in place of the drift flag (§7); a
  cut message's counters read "at least".

### The Approvals tab

An open (or expired) approval first, under an `h3`: "Open question", or "Unanswered question"
when expired. Then the question as a paragraph, the context, the files for an `out_of_plan`
approval as a list, and the options.

**Options** are a group of buttons, labelled by the question. Pressing one answers with it.
Each button's text is the option's label; the recommended one's text ends "(recommended)", so
the mark is in its name, not only in its look. An option's impact is the button's description,
shown beneath it.

**A written answer**: a Field labelled "Your answer", a Textarea, with the hint "Sent to the
agent as you write it.", and a button **Send answer**. For a `plan` approval the field's label is
"Changes to ask for".

Below, under an `h3` "Answered", earlier approvals as a list: each question, the answer given,
and when. With none at all, the kit's Empty: "No questions yet."

### Accessibility

As the MVP design's §8, which stands; this is what slice 2 adds to it.

**Structure.** The Approvals tab's headings are `h3` under the dialog's `h2`. The options group
is a `role="group"` named by the question's text through `aria-labelledby`. The answered list
is a list; each item names its question and answer in text.

**Focus order.** In the dialog: Close; the state line's actions — Move up, Move down, then
whichever of Mark done, Resume, Cancel run and Re-run apply; the tab list; the selected panel.
In the Approvals panel: the option buttons in their order, the answer field, Send answer, then
the answered list.

- Answering, by an option or Send answer, removes the controls that did it: focus moves to the
  state line, "<KEY>-<n> · <state>", before they go, as for the other buttons that change state.
- Resume and Cancel run on a paused or blocked card do the same.
- A card that moves to Needs approval while open does not move focus; it announces (below).

**Names.** Every control's name is its visible text: the option buttons by their labels, with
"(recommended)" in the name where it is shown; Send answer; Resume; Cancel run. The header's
count is text in the banner, not a control.

**States and announcements.** A busy option or Send answer is the button's `aria-busy`. Into the
card's status region, which is there from the card's first render:

- answering: "<KEY>-<n> answered. The run continues.";
- a question arriving while the card is open: "<KEY>-<n> has a question waiting in Approvals.",
  after the state change's own announcement;
- Resume: "<KEY>-<n> resumed."; Cancel run: the state change's announcement, as today.

The header's count is not announced: it changes with every run's questions, as the board's
moves do, and slice 1 decided not to announce those.

**Errors.**

- Send answer with an empty field marks the field invalid, describes it with "Write an answer,
  or choose one of the options.", and moves focus to it.
- An answer refused as stale (`409`): "This question was answered or withdrawn meanwhile; its
  latest state is shown." in the danger notice, which takes focus, and the tab refreshes.
- Any other failure: "The answer was not sent. Try again." in the danger notice, which takes
  focus; what was typed stays in the field.
- Colour carries nothing alone: "Question waiting", "(recommended)", "Paused" and the expired
  heading are words.

**Not covered by the automated checks.** A screen reader, 200% zoom and a 320 px viewport, on the
Approvals tab with a long question and five options: tried by hand, or named as untried in the
slice's review.

## 12. Errors

| Failure                                                          | Result                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `request_approval` with no running phase, or another open        | The tool's error, with the reason; nothing changes                                    |
| An answer to an approval answered, withdrawn, or not the block's | `409 conflict`                                                                        |
| An answer naming an option the approval lacks, or neither field  | `400 validation_error`, `details.field` `option_id` or `text`                         |
| A tool called after the pause, before the process exits          | The guard refuses it: "The run is paused; end your turn."                             |
| The paused process outlives 60 s after the marker                | Ended (§6); the pause stands; the phase is interrupted                                |
| The worktree is gone on resume                                   | The run fails: "the run's worktree is gone"                                           |
| The session is gone on resume, and held no message (§3, fact 12) | The phase starts again on a new session, in the same phase row                        |
| The session is gone on resume, and held messages (fact 10)       | The run fails: "the run's Claude Code session is gone; Re-run starts again from Plan" |
| `claude --resume` exits non-zero otherwise                       | The phase fails, as any phase failing does in slice 1                                 |
| A runner request outlives its timeout                            | Fails and is retried, as an unreachable server is in slice 1                          |
| The listening connection drops                                   | Reconnects with backoff; browsers get `resync`; the server stays up                   |
| `gh` cannot list a pull request's files                          | `200 { files: null }`, one warning line in the log without a stack                    |

## 13. Testing

The kit's testing rule applies, as in slice 1.

- **Unit**: the transition table's new rows; the event effects for `approval_requested`,
  `checkpoint`, a blocking `error` and a resumed `phase_start`; the resume message for each
  kind; the guard's out-of-plan reason, the allowed list, and its refusal of every tool once
  the run directory is marked paused; the event hook writing the marker on a successful
  `request_approval` and on nothing else; the sweeper's decisions as a pure function of the
  clock, the sleep-gap rule among its rows; the stage a checkpoint resumes from.
- **The normalizer over the recordings of §3**, a dataset of process sequences, one row each:
  each paused and resumed pair must sum to the resumed process's `modelUsage` exactly; each
  stopped process and its resume, from every table in §3, must count nothing twice, record a
  cut message from its `message_start`, and mark the phase interrupted; the reported cost must
  telescope to the last `costUSD` on the clean pairs. A missing session's result must read as a
  session that is gone.
- **Integration**: `request_approval` → Needs approval; answer → `NOTIFY` → claim returns
  `resume`; expiry and the lost-runner sweep with an injected clock; Cancel from Needs approval
  and from Blocked, and the cleanup it queues; the heartbeat's `pause` and `cancel`; the 401
  before the body is read; the PostgreSQL container restarted under a running server, which
  must answer afterwards and wake a claim; `gh` failing on the files route.
- **Runner against the fake `claude`**, which learns to pause and to be resumed (`--resume`
  replays the recorded resumed stream): a question in Build, answered, through to a pull
  request; the plan gate approved; the plan gate answered with changes, then approved; an
  out-of-plan edit allowed; a push that fails, then Resume through to a pull request; the
  daemon killed mid-phase, the run swept, then Resume; a phase whose session is gone with no
  message, started again on a new session; the daemon stopped with SIGTERM; a fake
  that keeps calling tools after its pause, refused and then ended after the grace period, run
  with the grace shortened by configuration; a server that never answers, which the daemon's
  timeouts survive.
- **UI**: a run that asks, answered by mouse; the same by keyboard alone, asserting where focus
  lands; Resume on a blocked card; axe-core on the Approvals tab open, expired, answered and
  empty, and on its error states.
- **Smoke**, by hand, on the owner's subscription: one real task whose spec leaves a question
  open, answered on the board, through to a pull request with its cost reconciled. During the
  same run the laptop sleeps for three minutes; on waking, the card must not be Blocked.

## 14. Documentation

The slice's last task updates `docs/architecture.md` — the lifecycle, a run's pauses, blocks and
resumes, what the runner reports, costs across a resume — and `README.md` where running
changed. It deletes the backlog entries this slice fixes, each in its fixing commit, and
archives the plan.

## 15. Open questions and what stays unproven

Settled by §3's recordings, which earlier drafts left open: what a stopped process does to the
session's totals (facts 7, 11 and 13), whether a model stops when told (fact 5), whether a
resume keeps the role (fact 4), how a missing session fails (fact 10), a process stopped before
its first message (fact 12), and one stopped after an earlier one ended by itself (fact 11).

- **Few recordings.** §3's pauses rest on one run per model, its stopped processes on two per
  case, all on 2.1.287. Stopping when told is a model's behaviour, not a guarantee; the guard
  and the 60 seconds bound what a model that does not stop can do. A Claude Code release can
  change the rest: re-record with the script, and the normalizer's tests read the new fixtures.
- **The subscription's usage limits.** On the owner's plan, Claude Code reports a
  `rate_limit_event` on every process — five-hour and seven-day windows, overage disabled — so a
  limit reached mid-run refuses requests rather than billing them. A phase refused that way
  fails the run, as any failed phase does; Re-run starts again from Plan once the window resets.
  Blocking instead, with the reset time on the card and Resume continuing the session, would fit
  this slice's machinery, but how a refused request appears in the stream is not recorded: it
  takes reaching the limit. Recorded in `docs/backlog.md`, for a later slice.
- **Paused worktrees accumulate** on disk while their questions wait; Cancel removes a run's. The
  MVP design's open question on retention covers the rest.
- **Laptop sleep** is handled by the sweeper's gap rule and the runner's timeouts (§8), tested
  with an injected clock, and once by hand in the smoke test.

## 16. Out of scope

Spec runs and their questions (slice 3); approvals raised by policy for destructive actions —
the guard's deny list stays a denial; budget thresholds; notifications outside the board; a
runner that resumes its own runs after a restart without the owner's Resume.
