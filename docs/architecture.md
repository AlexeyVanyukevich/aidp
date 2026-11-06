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
→ Done. A task in Backlog, Spec review or Failed goes straight to Done on Mark done, or on
`PATCH /api/tasks/:id` `{ state: 'done' }`, with no pull request involved: a fix made outside a run.

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
checkout that is missing again, fetching only for that (`runner/src/linked.ts`). A resume in
the Plan stage, or in a spec run's `spec` stage, does not restore: the refresh (see "The plan
gate" and "A spec run") remakes the checkouts from the claim's current `links`, so a link added since the run began gets one, a link
removed since loses its, and `linked.json` lists exactly the current links.

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
the note, then `<base branch="<base_branch>" commit="<sha>"/>`: the worktree's full HEAD when the
handoff is built, at the first start and at a restart. Its instructions carry the Spec tab's
template word for word and tell it to ask every open question in one batch. The phase pauses,
blocks and resumes like any other.

_The resume refresh._ Every resume whose checkpoint stage is `spec` — the owner's answer or the
nudge after a block — first runs the Plan-stage refresh (see "The plan gate") before any
spec-writer process starts, resumes or restarts: fetch, write `spec-base.txt` if it is missing,
undo uncommitted paths, `git merge --ff-only origin/<base>`, remake the linked checkouts from the
claim's current links, run the setup command again. A failure of any step is a `step_failed`
block at `spec` with no process run. The refresh rewrites `excluded-paths.json` only because it
reuses the Plan-stage refresh; nothing in a spec run reads that file. The spec-writer has no
commits of its own, which makes the undo and the fast-forward safe. A run paused before
`spec-base.txt` existed gets it written at the refresh, from the HEAD before the fast-forward.

_The base-moved note._ Each time a spec-writer process starts, resumes or restarts, the runner
writes the worktree's HEAD to `spec-base.txt` in the run directory (a spec run never writes
`plan-base.txt`). When the refresh leads to continuing the spec-writer's session and HEAD differs
from that commit, the message starts with the same note the planner gets, ending "Check your
questions and your draft against these changes, and save the spec again with save_spec if it
changes."; the resume's own message follows unchanged. A session started afresh gets no note.

_The saved answer._ A resume whose message is not the nudge first writes it to
`pending-answer.json` as words, so a refresh that blocks keeps the owner's answer. A later nudge
resume delivers the saved words instead of the nudge and sends the runner `tool_call` event
`saved_answer`. The file is deleted as soon as the resume or restart returns.

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
tests → Verify rounds. A report with no `fail` pushes the branch and opens the pull request, or
takes one already open for the branch. The worktree is removed when the run ends.

**How the lint reads Requirements and Acceptance criteria.** Items only: a list marker at column
0 followed by text. A line that starts with whitespace continues the item above it, joined with a
newline that keeps its indentation, and ids and parentheses are read from the item's first line
only. Every other non-blank line there, a lead-in sentence or a line of a fenced block, is a
`prose_in_list` finding with the section and the line, which blocks approval. Open questions
still reads every non-blank line.

**The owner check.** A criterion that no agent in a run can check, such as one that needs a
browser, carries the word `owner` in its parentheses: `- AC5 (R3, owner): Given … Then …`. The
spec parser stores `owner: true` on it (a criterion stored without the field reads as `false`);
`owner` is not a requirement reference, so `(owner)` alone still gets
`criterion_without_requirement`. Any other token in the parentheses that is not `R<n>` — `Owner`,
`ownr`, `r1` — is an `unknown_marker` finding, which blocks approval like any lint finding; empty
tokens left by stray separators are ignored. The verifier gives every criterion one of
three verdicts here (a fourth, `withdrawn`, is below) through `save_report`: `pass` or `fail` for an ordinary criterion, and for an owner check
`fail` when it can see the work is wrong and otherwise `owner`, with the evidence of what it did
check. `save_report` refuses `owner` on an unmarked criterion (`owner_on_unmarked_criterion`) and
`pass` on an owner check (`pass_on_owner_check`), saving nothing. A report with no `fail` opens the
pull request whether the rest are `pass` or `owner`; one `fail` starts the next Build round, and
the third ends the run `failed` with "verify failed three times". The owner sees what is left to
them as a sentence — "1 criterion is yours to check: AC5." or "2 criteria are yours to check:
AC5, AC6." — before the report table in the pull request body and above the table in the card's
PR tab, where an `owner` verdict is a `warning` badge with the text `owner`. The planner's check
for an owner-check criterion names the hand check, plus whatever a run can still check. The board
records no result of the hand check.

**Withdrawn criteria.** When the owner drops or changes an approved criterion in words at the
plan gate, `save_plan` takes an optional `withdrawn` list of `{ criterion, answer }`, stored in
the plan's `data` (a plan saved without it reads as an empty list). `answer` quotes the owner's
words, whole or as an excerpt. The quote check collapses whitespace: every run of it, line
breaks included, becomes one space on both sides and trims them, then looks for the answer as a substring of
any worded plan-gate answer on the run's spec version, from any delivery run of the task, this
one included. `save_plan` refuses, saving nothing, with these findings: `unknown_withdrawn_criterion`
(an id the spec lacks), `duplicate_withdrawn_criterion`, `withdrawal_without_gate` (confidence
`high` with a non-empty list, since a withdrawal takes effect only once the owner approves),
`withdrawn_criterion_with_check` (a withdrawn id with a row in the checks) and
`withdrawn_answer_not_found`. A withdrawn criterion needs no check. The rendered plan ends with
`Withdrawn by the owner:` and one `- <id> — <answer>` line per entry. The verifier gives a
criterion the verdict `withdrawn` only when the run's accepted plan (the newest plan of the run
that counts as accepted, below) lists it; `save_report` refuses `withdrawn` otherwise
(`withdrawn_not_in_plan`) and refuses any other verdict on a withdrawn criterion
(`withdrawn_criterion_judged`). The server writes the report's own `withdrawn` list into its
`data`, from the accepted plan; the agent cannot supply it. The report body and the pull request
body show `⊘ withdrawn` and a block `Withdrawn by the owner at the plan gate:` with one line per
entry, after the owner sentence and before the table; the PR tab shows a `neutral` badge with the
text `withdrawn` and the same words as a paragraph and a list above the table. A report with
`pass`, `owner` and `withdrawn` verdicts and no `fail` opens the pull request.

**The setup command.** A project may carry a `setup_command` (at most 500 characters), set when
it is registered or later with `PATCH /api/projects/:key`, whose body is `setup_command` (string
or null) alone: any other field, or an empty body, is refused with 400,
and an unknown key answers 404. A null or blank `setup_command` clears it. A command whose first
word does not resolve in `repo_path` is refused with `validation_error` on its field. The
Projects page shows each project's setup command with an `Edit setup command of <KEY>` button,
which opens a form (`Setup command of <KEY>`, `Save`, `Cancel`). A refusal stays on the field,
and any other failure is written into the form's own alert. The next claim carries the changed
command to the runner.
In the `prepare`
stage of every spec run and delivery run, once the worktree is checked out, the runner runs it
with `sh -c` in the worktree, bounded by `TEST_TIMEOUT_MS`, before any phase starts: it is how
the repository's dependencies — and so the `charter` rules `CLAUDE.md` imports — are there when
the agents' sessions begin. It is reported as a `tool_call` event named `setup_command`, with the
test command's payload (exit code, timeout, the end of the output). A null command runs nothing.
One that exits non-zero or times out blocks the run as `step_failed`, carrying the command and
the last 4,096 characters of its output; the checkpoint stays in `prepare`, and Resume recreates
the worktree and runs the command again.

**The environment of commands and sessions.** The setup command, the test command and the agents'
`claude` sessions do not receive `RUNNER_KEY`, `DATABASE_URL`, `PORT` or any variable starting
with `BOARD_`. A session keeps only the nine run variables the runner sets for it: `BOARD_URL`,
`BOARD_RUN_TOKEN`, `BOARD_RUN_ID`, `BOARD_PHASE_ID`, `BOARD_PHASE`, `BOARD_AGENT`,
`BOARD_RUN_DIR`, `BOARD_WORKTREE` and `BOARD_RUNNER_CODE` (the runner's code fingerprint, below). The setup command and the test command each get their own
temporary `BOARD_HOME`, a fresh `aidp-command-*` directory under the OS temporary directory,
deleted before `runTestCommand` resolves (after exit, non-zero exit and timeout alike; a failed
removal is ignored). When that directory cannot be made, the command does not run: the result has
a null exit code, no timeout, and an output saying no temporary `BOARD_HOME` could be created,
with the error's message, so the setup command blocks the run as `step_failed` and Verify sees
that output. Everything else the runner's environment holds still reaches them — `SMOKE_*` and
any other variable the owner's shell exports — accepted because the board runs on one owner's
machine. The runner and server test suites also run with a temporary `BOARD_HOME`, made by their
globalSetup and removed at the end, so they never touch the owner's `~/.aidp`.

**Test commands.** A project keeps several named test commands in `project_test_commands` (`id`,
`project_id`, `name`, `command`, `is_default`, `created_at`), deleted with the project. A unique
index on (`project_id`, `lower(name)`) keeps names distinct ignoring case, and a partial unique
index on `project_id` where `is_default` keeps one default. Every project has exactly one default
at all times: registration inserts `tests` running `npm test` (unchecked against the repository,
and `POST /api/projects` refuses a `test_command`), making another the default clears the old one
in the same transaction, and the default cannot be removed. `GET /api/projects` lists each
project's `test_commands` (`{ id, name, command, is_default }`, ordered by `lower(name)`) and has
no `test_command`. Four routes manage them: `GET /api/projects/:key/test-commands`; `POST` with
`{ name, command }`, which adds a non-default command and answers 201; `PATCH
/api/projects/:key/test-commands/:id` with at least one of `name`, `command` and `is_default`
(only `true`), written all or none; and `DELETE`, which answers 204, or `409 conflict` for the
default. A name is trimmed, 1 to 40 characters and unique in the project; a command is non-blank,
at most 500 characters, and its first word must resolve in `repo_path`. A refusal is
`validation_error` naming `name` or `command`, the name checked first; a name the unique index
refuses when two adds race is the same refusal, never a 500. An id of another project is 404.
Every add, edit, default change and removal publishes `project.updated` (with the project's key)
in its transaction, which the stream forwards; a removal also publishes `task.updated` for each
task it reset.

A task refers to its command by `tasks.test_command_id` (null means the project's default; the
foreign key sets it null when the command is removed, in any state), so renaming or editing a
command keeps the choice. `PATCH /api/tasks/:id` accepts it as a uuid or null: an id of another
project is `validation_error` naming `test_command_id`, and a task in Done answers `409 conflict`.
At the first claim of a delivery run the server stores the chosen command's text, else the
default's, in `runs.test_command`; every claim of that run, start or resume, carries that text as
`run.project.test_command`, so a later choice, edit, default change or removal does not reach a
started run. A spec run's claim carries the task's chosen command, else the default, read at claim
and not stored. `GET /api/tasks/:id` carries `test_command_id` and `tested_with`, the
`test_command` of the task's latest delivery run that has started (a newer run that never started
does not hide an older one), or null.

The settings page, at `/p/<KEY>/settings`, has one `main`: a `Board of <KEY>` link, the h1
`<KEY> settings` (which takes focus on arrival), a status region, and the list read through the
loading wrapper (`This project could not be loaded.` with Retry on failure). Loaded, it holds an
h2 `Test commands` over the list's alert region and the list `Test commands of <KEY>`, then an h2
`Add a test command` over a form with its own alert region; every live region is in the page
before anything is written into it. Each item shows the name, the command and, on the default,
`Default`, with `Edit <name>`, and, off the default, `Make <name> the default` and `Remove
<name>`. Edit replaces the item with a form (`Name of <name>`, `Command of <name>`, Save, Cancel)
and moves focus to its Name field; Save or Cancel returns focus to the item's Edit button. The
status region announces `<name> added.`, `<name> saved.`, `<name> is now the default.` and `<name>
removed. Tasks that chose it now use the default.`; focus stays on the add form's Name field after
an add, moves to the item's Edit button after Make default, and to the list after a removal. A
refusal naming `name` or `command` sets `aria-invalid` and `aria-describedby` on that field and
focuses it; any other failure is written into the alert of the form or list it came from, which
takes focus. The board's header links to the page (`Settings of <KEY>`). On the Projects page each
project shows `Default test command: <name> (<command>)`, and the stream's `project.updated`
refreshes the project list and the project's test-command list.

On a card that is not Done, a `Test command` select sits between the actions and the tabs, with
a hint that a named command does not follow a changed default and a started run keeps its
command. Its options are `Project default (<default name>)`, then the project's commands in the
list's order, refreshed by `project.updated`. Choosing saves at once with `PATCH /api/tasks/:id`
and announces `<KEY> will test with <name>.` or `<KEY> will test with the project default
(<name>).` in the card's status region, focus staying on the select; a failure goes into the
card's problem region, which takes focus, and the select shows the saved choice again. In
Running, Needs approval, Blocked and Review with a `tested_with`, `This run tests with <command>.`
sits under the select. A Done card shows `Tested with: <command>` or `No run tested this task.`
in place of the select.

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
whatever its confidence, and asks the planner to shorten it. The rendered text escapes each `|` in a
check as `\|` and writes a line break as a space, so the table holds its columns, and the limit
counts the escaped text. If the board refuses the gate's
request with a 4xx answer, the run fails with a sentence naming the field and the problem.

_The Plan-stage refresh._ Every resume of a run whose checkpoint stage is `plan` and that holds no
kept plan (an answer in words at the gate, Approve plan, an answer to the planner's own question,
or Resume of a run blocked there) first moves the run to the current base, before any planner
process or Build starts. In order, the runner: runs `git fetch origin <base>` in the project's
`repo_path`; writes the worktree's HEAD to `plan-base.txt` if that file is missing; undoes every
uncommitted path (staged, unstaged, untracked, never ignored), restoring a path HEAD tracks to its
content at HEAD and deleting one it does not; fast-forwards the branch with `git merge --ff-only
origin/<base>`; remakes the linked checkouts from the claim's current links; runs the setup
command again (a `setup_command` event); and rewrites `excluded-paths.json` to the uncommitted
list, or to an empty list for a project without a setup command; a setup that succeeded writes
`setup-base.txt` (see "The tests stage on the current base"). A failure of any step is a
`step_failed` block at `plan`, with no phase process run. The Plan phase's branch has no commits of
its own, which is why the undo and the fast-forward are safe there. A run holding a kept plan
refreshes nothing, and a resume at Build or Verify refreshes nothing. A spec run's resume at the
`spec` stage uses the same refresh (see "A spec run"). Approve plan does the refresh, then ends the phase
and starts Build as before.

_The base-moved note._ Each time a planner process starts, resumes or restarts, the runner writes
the worktree's HEAD to `plan-base.txt` in the run directory: the commit the planner last read.
When the refresh leads to continuing the planner's session and HEAD differs from that commit, the
message starts with a note: the old and new commits, the number of commits between them, the paths
changed between them (sorted, the first 100, then `and <k> more`), and a request to check the plan
and save a revised one with `save_plan`; the owner's message follows unchanged. A planner session
started afresh gets no note. A run paused before `plan-base.txt` existed resumes without error.

_The saved answer._ Before the refresh, the runner writes the answer the resume is about to
deliver to `pending-answer.json` (the words, or an approval), replacing any earlier one. If the
refresh blocks, the owner's Resume carries only the nudge; when `pending-answer.json` exists the
runner delivers the saved answer in its place and sends a runner `tool_call` event `saved_answer`
(`delivered the owner's answer kept from before the block`, or `went on to Build on the Approve
plan kept from before the block`), which the Timeline shows. Saved words are deleted as soon as
`phases.resume` or `phases.restart` returns, whatever the process's result; a saved approval is
deleted once the `build` checkpoint is sent; a refresh that blocks, or a process that fails to
start, leaves the file. A message other than the nudge is never replaced.

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

  The claim also carries `plan_answers: { run, approved, text }[]`, the owner's words at plan
  gates: the answered `plan` approvals of the task's delivery runs on the same spec version
  whose answer text is not blank, the run's own included and a run that holds a kept plan
  included, oldest answered first (ties by approval id), with the text trimmed; `approved` is
  true exactly when the answer chose Approve plan. An older board's absent field counts as
  empty. The Plan phase's handoff leaves out the answers of the current run, which the planner's
  resume message already carries; the Verify phase's handoff carries every one, with the same
  `<plan_answer>` tags, so the verifier can read the words behind a withdrawal. Build's handoff
  carries none. Each is one `<plan_answer run="<n>" approved="yes|no">` tag,
  after the `<previous_plan>` tags. Their trimmed texts total at most 20,000 characters,
  counted before escaping: the runner keeps the newest whole, stops at the first that would
  overflow, leaves every older one out, and adds
  `<plan_answers_left_out count="<k>" runs="<r1>,<r2>,…"/>` after the last tag. The planner's
  instructions say the new plan keeps every correction, or names the one the spec or the code
  rules out and says why; the newer of two conflicting answers wins; and the left-out tag means
  older answers were not shown.

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
to the allowed list for the rest of the run. The guard checks a path against the run's worktree,
taken from `BOARD_WORKTREE` (set by the runner in every phase process) and resolved with
`realpathSync`, whatever directory the last `Bash` call ended in; the hook input's `cwd` only
resolves a relative tool path. It compares the path in its canonical form (`canonicalPath`: the
real path of the deepest existing ancestor, then the remaining segments), so a path reaching the
worktree through a symlink gets the verdict of its real form; a `.env` name is refused in either
form. A path with no canonical form is refused. When `BOARD_WORKTREE` is unset, empty or does not
resolve, the guard refuses every tool call, naming the variable.

_The files gate._ The guard checks only the file tools, so a change written through `Bash` (a
script, `sed -i`) is checked afterwards, on what the worktree holds. In the `tests` stage, after
the stage's fetch and setup (see "The tests stage on the current base") and before the rebase, the
commit count and the test command, the runner lists the paths the branch
changes: _committed_ is the net difference from the merge-base with `origin/<base>` as last
fetched (`git diff -z --name-only --no-renames`, so deletions and both sides of a rename count and
a path restored to its fork-point content does not), _uncommitted_ is staged, unstaged and
untracked paths, never ignored ones. Every listing runs with `-z`, so a path with non-ASCII
characters or quotes comes back as stored. A path that is not in the run's allowed files, or is a
migration the owner has not approved (even if the plan lists it), is a violation. With any, the
runner writes `files-gate-report.md` in the run directory, does not run the test command, and sends Build round again with
the failing report `files_gate` in the checkpoint; `handoffFor('build')` reads the report from
the file, or uses a fixed text when it is missing. The report wins over a build with no commit,
and a run resumed at the `tests` stage runs the gate again. It shares Verify's three attempts;
a violation on attempt 3 ends the run `failed` with `the build changed files the run does not
allow, on attempt 3: <paths>` (the first 20 paths, then `and <n> more`). Each gate run sends a
runner `tool_call` event `files_gate`: `error` with `<n> paths the run does not allow` and the
`violations` (`path`, `reason`, `committed`) in its payload, or `ok` with `every changed path is
allowed`. When the gate passes it records the worktree's `HEAD` (`gate-head.txt`).

_Excluded paths._ What the runner's own commands write is not the builder's. `excluded-paths.json`
holds those paths: right after the setup command in `prepare` (and again in each Plan-stage
refresh and each run of setup in the tests stage) it is set to the uncommitted list,
and around each run of the test command the runner adds every uncommitted path that the run
created. Exclusions apply to the uncommitted list only and go by path; a committed path is never
excluded, so committing `git add -A` output of setup is a violation. Files the builder's own
commands create before the runner's first test run are not excluded: on attempt 1 they count
until the builder deletes them, which is the cost of a builder that runs the tests itself.

_The tests stage on the current base._ The tests and Verify run on the branch rebased onto the
base as it stands when the `tests` stage starts, with setup run on that base. In order, the
runner:

1. Finds a rebase of the run's branch still in progress, and treats it as a conflict (below). A
   rebase is of the run's branch when `git rev-parse --git-path rebase-merge` or `rebase-apply`
   (a linked worktree's `.git` is a file, so the state is never joined onto the worktree
   directory) names a directory whose `head-name` is `refs/heads/<branch>`; its `onto` file is the
   commit the rebase is onto.
2. Runs `git fetch origin <base>` in the project's `repo_path`. A rebase is owed when
   `origin/<base>` is not an ancestor of HEAD.
3. When setup is owed, undoes every uncommitted path; unless a rebase is owed, it then runs the
   setup command (a `setup_command` event), rewrites `excluded-paths.json` to the uncommitted list
   and writes `setup-base.txt`. A failed setup blocks the run as `step_failed` at `tests`.
4. Runs the files gate.
5. When a rebase is owed: undoes every uncommitted path, runs `git rebase origin/<base>`, and on
   success runs setup, rewrites `excluded-paths.json` and writes `setup-base.txt`.
6. Writes the worktree's HEAD to `gate-head.txt`, so the push stage compares against the rebased
   HEAD, and the fetched `origin/<base>` commit to `tested-base.txt`. Then the commit count and the
   test command run.

`setup-base.txt` holds the merge-base of HEAD and `origin/<base>` as of the last setup that
succeeded: `prepare`, the Plan-stage refresh, a worktree remade on resume, and the tests stage
each write it after a successful setup, and a failed setup leaves it as it was. Setup is owed when
the project has a setup command and the file is missing or differs from that merge-base, so a
branch the builder or the owner rebased gets setup again, and a run started before the file
existed gets it once.

Each time the runner undoes uncommitted paths in this stage it first takes the ones not in
`excluded-paths.json`, which are the builder's; when there are any it sends a runner `tool_call`
event `undo_uncommitted` (status `ok`, target `undid <n> paths the build left uncommitted`,
payload `paths`). Uncommitted edits to allowed files stay in place when no rebase is owed and
setup is not (AIDP-72).

A rebase that succeeded sends a `base_rebase` event, status `ok`, target `rebased onto <sha>, <n>
commits later`, payload `from` (the merge-base before), `to`, `commits` and `paths`. A conflict,
whether from the runner's rebase or a half-finished one found in step 1 (the builder left it, or a
resume found it), does not run the test command. The runner lists the unmerged paths, runs `git
rebase --abort` (which leaves the branch as it was), undoes every uncommitted path, sets
`excluded-paths.json` to an empty list, deletes `setup-base.txt` and writes
`base-conflict-report.md`: the commit the rebase was onto, the conflicting paths, and the
instruction to run `git rebase origin/<base>`, resolve, `git add` and `git rebase --continue`. A
`base_rebase` event with status `error`, target `<n> paths conflict with the base` and payload `to`
and `conflicts` is sent. On attempt 1 or 2 Build goes round again with the failing report
`base_conflict` in the checkpoint, sharing Verify's three attempts; `handoffFor('build')` reads the
report from the file, or uses a fixed text when it is missing. On attempt 3 the run is blocked
instead of ended: `step_failed` at `tests`, command `git rebase origin/<base>`, output the paths
and the instruction to rebase by hand and Resume. The attempt stays at 3, and Resume runs the
`tests` stage again from step 1. A tests stage where no rebase was owed and none was in progress
sends no `base_rebase` event. The linked checkouts are not fetched or remade in the `tests` or
`push` stage, nothing force-pushes, and the base is never merged in.

_The half-finished rebase on resume._ A resume whose worktree is not on the run's branch looks for
a rebase of that branch in progress (above). Without one the run ends `failed` with "the run's
worktree is gone". With one, the run goes on at `build` (the builder's session continues with the
rebase in place) and at `tests` (step 1); at `plan`, `verify`, `push` or `pr` it blocks as
`step_failed` at that stage, command `git rebase`, with output telling the owner to abort it with
`git rebase --abort` and Resume. An owner who finished the rebase instead moves HEAD, and a run
resumed at `verify` or `push` ends at `push` with "Verify changed the branch".

_The verifier's note._ When Build's attempt 1 begins, the runner writes the merge-base of HEAD and
`origin/<base>` to `build-base.txt` if it is missing. Each time a Verify handoff is built, the
reference is `verify-base.txt` if present and `build-base.txt` otherwise; when `tested-base.txt`
differs from it, the handoff carries a `<note>`: the base moved since Build began (or since the
last Verify), the old and new commits and the commits between them, the paths changed (sorted, the
first 100, then `and <k> more`), and a request to check that the change still meets the spec with
those changes in place. The runner then writes the tested base to `verify-base.txt`. A missing
`tested-base.txt`, or no reference, gives no note; resuming a Verify session adds none.

_The check before the push._ When `tested-base.txt` exists, the `push` stage runs `git fetch
origin <base>` again before the branch is pushed. When `origin/<base>` differs from the tested
base, the runner writes the commits `<tested>..origin/<base>` to `untested-commits.json` (a list of
`{ sha, subject }`) and sends a runner `tool_call` event `base_check` (status `error`, target `<n>
commits reached <base> after the tests`, payload `tested`, `now` and `commits`); when it is equal,
the file is removed and nothing is sent. The branch is pushed either way with the same `-u origin
<branch>` and no force: a base that moves after the tests is recorded, not tested again. A failed
fetch blocks the run as `step_failed`. A run without `tested-base.txt` fetches and compares
nothing.

_The pull request body._ After its first line the body has ``Tested on `<base>` at `<sha>`.``
(from `tested-base.txt`); when `untested-commits.json` lists commits, a section `## Not tested with
this change` follows, before the Verify report, with one `<sha> <subject>` line per commit (the
first 20, then `and <k> more`). A run without `tested-base.txt` writes the body as before.

_Feedback on Bash._ After each `Bash` call in Build, the PostToolUse hook runs the same
computation and, with any violation, writes `{"decision":"block","reason":…}` with the report's
text, so the builder learns at once, with the commands that undo it (`git checkout <hash> -- <path>`
with the merge-base's full hash, `git rm`, deleting a generated file). In every other case
(another phase or tool, no violation, no `allowed-files.json` yet, or a failing git command or
run-directory file) it writes nothing; it records its event and exits 0 whatever happens. It lists
the paths of the worktree in `BOARD_WORKTREE`, resolved to its real path, whatever directory the
call ended in (`changedPaths` runs every listing at the git top level, so untracked paths cover the
whole worktree). The one board failure it does report: when the phase, tool and run-directory
files call for the check but the variable is unset, empty or does not resolve, it blocks with a
reason saying the files check could not run, naming `BOARD_WORKTREE`.

_A git failure._ A `GitError` in the gate blocks the run at the `tests` stage with `step_failed`;
the test command does not run, and Resume runs the gate again.

**Migration approval.** A migration is a file under a `migrations/` directory whose name does not
start with `index.`; the registry (`index.*`) is an ordinary file, held to the plan alone. In
Build the guard refuses to create one, or to change one already in the worktree, even when the
plan or an `out_of_plan` answer lists it, and tells the builder to ask with `request_approval`
kind `migration`: the path in `files`, a summary in `question` (what it changes, and whether its
down step undoes it), and the whole file in `context_md` (up to 20,000 characters; `plan` approvals hold 20,000 too, `question`, `out_of_plan` and
`questions` 8,000). The request offers `allow` and `refuse` and pauses the run as an `out_of_plan` one does.
The Approvals tab shows the summary, the path, and the file as plain text in a monospace block
(never rendered as Markdown).
Allowing adds the path to the run's allowed files and approves its content for the rest of the
run: the approval covers the path and the exact text the owner reviewed.

_Content._ `context_md` is the raw file, exactly as it will be written. A `context_md` wrapped in
a Markdown code fence (its first line opens one with three backticks or tildes, and its last
non-blank line closes it) is refused with a `fenced` finding on `context_md`; no request is
opened and the run does not pause. The server stores `context_md` as sent and never reformats it,
so the builder formats the file as the project's formatter would before asking (for example with
`npx prettier --stdin-filepath <path>` where the project uses prettier) and writes the allowed
text with a single Write. For each path the approved content is the `context_md` of the most
recently answered request for it that the owner allowed, whatever its age; a later refusal leaves
it in force, and its resume message carries the earlier approved content, fenced, and tells the
builder to put it back. The claim's `approved_migrations`, and the runner's
`approved-migrations.json` beside `allowed-files.json`, hold `{ path, content }` entries, each
path once. A claim in the old form (plain strings) ends the delivery run `failed` before any
phase starts; an old-form or malformed `approved-migrations.json` makes the guard refuse every
call and the files gate fail the run.

_Enforcement._ Two texts are the same content when they are equal after reading CRLF as LF and
any run of final newlines (or none) as one. In Build the guard allows a Write to an approved
path only with such content, and refuses any other Write with the approved content, fenced, in
the reason; it refuses Edit, MultiEdit and NotebookEdit there, since an approved migration is
written whole. Outside Build the guard still refuses to create a migration. The guard allows
every `Bash` command, so the files gate and the PostToolUse Bash hook check content too: an
approved path among the changed paths whose worktree file is missing or differs, or, when it is
committed, whose copy at `HEAD` is missing or differs, is a violation with the reason "a
migration that differs from the one the owner approved". The report tells the builder to write
the approved content again with one Write, or to ask again with kind `migration`, and names where
the approved version is; it carries no content. Only the worktree and `HEAD` are checked: an
earlier commit on the branch can still carry other content in the branch's history, which is
accepted, since the file at `HEAD` is the one applied on the next server start.

_Handoff._ Every Build handoff, whatever the attempt and whatever started the session (including
a restarted phase), carries one `<approved_migration path="…">` element per approved migration,
in path order. Its text is not HTML-escaped: it holds the content in a fence one backtick longer
than the longest run of backticks in it (at least three), never cut, so a closing tag inside the
content is harmless. Plan and Verify handoffs do not carry it. The runner and the server each
hold a fencing function, tested against the shared table `tests/fixtures/migration-fence.json`.

The files gate holds a migration the owner has not approved to the same rule for
a change written through `Bash`: it is a violation even when the plan lists it, with the reason
"a migration the owner has not approved", and the report tells the builder to ask with kind
`migration`.

_Order._ A migration's name is its file name without its last extension; its siblings are the
other migrations directly in its directory, in the run's worktree and on `origin/<base>` as last
fetched (`index.*` files excluded). Migrations apply in name order, compared by UTF-16 code unit
as the migrator's own sort does, so a new migration (a path not in the worktree) whose name is
equal to or sorts before a sibling's would stop the server at start. The guard denies creating
such a migration even when the plan lists it, naming the sibling with the greatest name, which a
new name must sort after, and does not tell the builder to ask. `request_approval` kind
`migration` refuses the same path with an `out_of_order` finding on `files[0]` carrying that name
as `after`; no request is opened and the run does not pause. The server reads the siblings
(worktree directory, then `git ls-tree` of `origin/<base>` in the project's `repo_path`) before
the transaction opens. The guard learns the base from `base-branch.txt` in the run directory,
which the runner writes on every start and resume. Nothing is fetched: when `origin/<base>`
cannot be read, only the worktree's directory is compared, and when that directory does not
exist, only `origin/<base>`. A migration path the owner already allowed is not checked again,
and changing an existing migration has no order check. The order is not checked again before
push, so a base that gains a later migration in the meantime can still leave a branch out of
order.

**Migrations on start.** `server/src/server.ts` applies every pending migration before it
listens. A failed one is logged by name with the database's error, the server exits non-zero
without listening, and the migration is not recorded as applied. `npm run migrate` (and
`./run migrate`) applies them without starting the server and fails the same way.

**Blocks.** The sweeper, every `SWEEP_MS`, blocks a running run with no heartbeat for 90 seconds
(`runner_lost`, its phase marked interrupted) and a question open for 48 hours
(`approval_expired`); a tick after a gap of more than two intervals — the machine slept —
decides nothing. The runner blocks a run whose `git` or `gh` step failed (`step_failed`, with the
command and the end of its output) and one it was stopped in (`runner_stopped`). A Claude Code
process that fails to start blocks the run the same way (`step_failed`), with the binary as the
command and Node's message, its code and a hint as the output (`CLAUDE_BIN`, the runner's `PATH`
or the run's worktree, whichever the failure points at). Resume runs the process again: a phase
that never started gets a new session in the same phase row, and a resumed one continues its own.
An `'error'` after the process started is logged to the phase's stderr log, and the `'close'` that
follows a start failure is ignored. Resume continues from the checkpoint with "You were
interrupted. Continue from where you stopped."; a stage with no session reruns its step. A session
Claude Code deleted fails the run, while a session killed before its first message is started
again on a new session in the same phase row. A worktree that is gone is made again (see "A lost
worktree").

**Cancel** of a paused or blocked run withdraws its question and queues a cleanup, which the
runner claims and answers by removing the worktree and the linked checkouts, found by its own
path convention. A cleanup sends no `run_end`: the board has already ended the run. It has no
token, so its removals are logged and sent as no event.

**The run's end and its worktree.** The runner sends `run_end` first, and removes the worktree
and the linked checkouts only once the send resolved, whether the board answered or the event
was spooled to `events.ndjson`. When the board refuses `run_end` (a 401, say), the worktree and
checkouts are kept, a `keep` line is logged, and the error reaches the daemon, so the board
blocks the run as `runner_lost` and Resume continues from its checkpoint. A runner that stops
after the board accepted `run_end` but before the removal leaves the worktree on disk; such a
run has no `remove` line in the log.

**The removal log.** Every removal attempt, refusal and kept worktree appends one JSON line, in
one write, to `<BOARD_HOME>/worktree-removals.log`: `time` (ISO 8601, UTC), `pid`, `action`
(`remove` for a worktree, `delete` for the `-linked` directory or a re-creation's leftover,
`recreate`, `keep`), `run_id`, `caller` (`run_end`, `delivery_prepare`, `draft_prepare`,
`linked_prepare`, `cleanup`, `recreate`, or `delivery_resume` and `draft_resume` for
re-creations), `path` as the caller gave it, `resolved` (the canonical path, when there is one),
`result` (`removed`, `deleted`, `absent`, `failed`, `refused`, `recreated`, `kept`) and `output`
(git's error, a refusal's reason or the error message; only for `failed`, `refused` and `kept`,
the last 4,096 characters). A failed log write, a failed removal and a refusal are never thrown.
The file is not rotated. A removal that is logged `removed`, `deleted`, `failed` or `refused`
also sends a runner `tool_call` named `remove_worktree` (target the path, status `ok` or
`error`, payload `action`, `caller`, `result`, `run_id`, and `resolved` and `output` when
present), after `run_end` for the run's end; `absent` sends none.

**The path guard.** Before anything is removed or deleted, the path goes through one guard. The
canonical path of a path is the `realpathSync` of its deepest existing ancestor followed by the
remaining segments, so a worktree already gone keeps the canonical path of where it was; a
relative path, a `.` or `..` segment, or any error other than "does not exist" (a symlink loop,
a denied directory) gives none and is refused. `<BOARD_HOME>` is resolved the same way. The
canonical path must be `<home>/worktrees/<run id>`, `<home>/worktrees/<run id>-linked` or a
direct child of the latter; it is then the path git is given. A path that fails is not given to
git and nothing is deleted. A path that does not exist is logged `absent` and git is not called.
Every `git worktree add` runs `git worktree prune` on the repository first, so a worktree whose
directory is gone does not block a new one at the same path.

**A lost worktree.** A delivery run resumed past `prepare` whose worktree directory does not
exist adds it again on its branch `board/<KEY>-r<n>`, runs the setup command and replaces the
excluded paths with what setup left (a Plan-stage resume skips setup there, since its refresh
runs it), and continues from its checkpoint. If the branch is gone too the run ends `failed`
with "the run's worktree and its branch <branch> are gone". A spec run resumed past `prepare`
gets a detached worktree of `origin/<base>` again, then the Spec-stage refresh runs as usual; the
worktree is at the base's current tip while `spec-base.txt` keeps the base the spec-writer last
read, so the base-moved note reports the difference. A worktree that exists on another branch
still fails the run, unless a rebase of the run's branch is in progress there (see "The
half-finished rebase on resume"). A delivery run's remade worktree writes `setup-base.txt` after
its setup. Each re-creation logs a `recreate` line and sends a `recreate_worktree`
tool call (target the path, status `ok` or `error`, payload `caller`, `result`, the branch, the
new HEAD, and `output` on failure). A failed add or setup blocks the run as `step_failed`, after
what was left at the path is cleared through the guard (caller `recreate`); the next Resume
re-creates it again. Uncommitted work in a lost worktree is not recovered.

## What the runner reports

Events, through `POST /api/runner/events`, idempotent on their ids. `phase_start`, `phase_end`,
`run_end`, `checkpoint`, a blocking `error` and the plan gate's `approval_requested` also move
the board. Usage per message comes from the stream's `message_delta`; a message cut off before
it is recorded from its `message_start`, marked `cut`. A subagent's usage comes from its `Agent`
result; the remainder of each process's `modelUsage`, beyond the session's previous totals, is one
`claude-code` event. While the board is unreachable, events wait in the run directory's
`events.ndjson` and replay in order. The runner's own events travel with the token the runner
issues at the start of its carry (12 hours), never a phase's token; a phase's process gets its
own, retired when it ends. Every request the runner makes times out — a claim's wait
plus 10 seconds, 30 seconds otherwise — and is retried.

## Costs

Never stored: every figure is events × the price row in effect on the event's day
(`./run price:set`). Claude Code reports a resumed session's usage cumulatively, so a phase's
reported cost is the sum of each process's share beyond the session's previous total. The Cost
tab flags a phase more than 2% apart from it, which means a stale price row — except a phase
marked **interrupted**, one a process of which was stopped or lost, whose own figure in Claude
Code misses part of it and which is not compared.

## Security

New migrations, and changes to migrations from the base branch, need the owner's approval. A new
migration whose name sorts at or before a sibling's, in the worktree or on `origin/<base>` as last
fetched, is refused by the guard and by the `migration` request, never put to the owner; see
"Migration approval".

The owner's approval of a migration covers its content as well as its path: the guard, the files
gate and the Bash hook allow only the text the owner reviewed at that path, in the worktree and
at `HEAD`, and a `migration` request whose `context_md` is wrapped in a code fence is refused;
see "Migration approval".

No sign-in: the server binds 127.0.0.1, answers only to `ALLOWED_HOSTS`, and refuses writes
from a foreign `Origin`. The runner authenticates with `RUNNER_KEY`; each `claude` process gets
a run token limited to its run, retired five minutes after the process exits. The runner's own
events use a separate run token, issued when it takes up the run, that lasts 12 hours; a single
carry longer than that has its events refused. Runner credentials
are checked before a request's body is read. The guard denies `rm -rf`, `git push`,
`git reset --hard`, `.env` files, paths outside the worktree, in Build any file the run has not allowed, `Bash` or `Agent` sent to the background (`run_in_background: true`,
which a `-p` process loses when its turn ends), and — once the run is paused — every tool. In every phase it also denies `git commit` with
`--no-verify` or `-n` (alone or inside a cluster such as `-an`), and `git -c core.hooksPath=…
commit`, with a reason saying the commit-msg hook must not be skipped; text inside a `-m` value
never matches.

The guard sees what a tool is asked to do, not what a `Bash` command writes, so Build's file list
is also checked on the worktree: by the files gate before the test command, and by the PostToolUse
hook after each `Bash` call (see "Out-of-plan edits"). Both read the changed paths through `git`
with `-z`. Before the push, the runner compares the worktree's `HEAD` with the one recorded at
the end of the tests stage, after any rebase onto the base; if Verify committed, the run ends
`failed` with `Verify changed the branch: HEAD is <sha>, Build ended on <sha>` and nothing is
pushed (a run started before the gate existed has no record and pushes as before). The push stage
then fetches the base again, only to record what arrived after the tests (see "The tests stage on
the current base"); the push is never forced. A `Bash` write outside the worktree is not caught.

The guard reads `linked.json`. Edit, Write, MultiEdit and NotebookEdit on a path inside a linked
checkout or a linked project's `repo_path` are refused, naming the project's key and saying linked
repositories are read-only. Read, Grep and Glob are allowed inside a checkout; on a linked
`repo_path` they are refused with a reason pointing to the checkout, as is a `Bash` command that
contains a linked `repo_path`. A `Bash` command naming only the checkout is allowed: a write
through `Bash` into a checkout is not caught, and the checkout is thrown away when the run ends.
Other paths outside the worktree are refused by the file tools as before.

**The guard fails closed.** The guard is registered with matcher `*`, so it runs before every
tool, the board's MCP tools included. Claude Code blocks a call only on exit 2 or a `deny` on
stdout, and lets it go ahead on any other failure, so a guard that cannot check a call refuses it.
A missing `BOARD_RUN_DIR` or `BOARD_PHASE`, hook input that is not JSON, or a present but
malformed `allowed-files.json`, `approved-migrations.json` or `linked.json` (unreadable, not JSON,
or not a list of strings, or of checkouts with a `key`, `repo_path` and `path`) is such a failure.
The guard writes `The guard could not check this call: <error>. End your turn, and say why in your
last message; do not work around it.` as a `deny` on stdout, the error on a `board-cli guard: `
line on stderr, and exits 0. The reason tells the agent to end its turn because
`request_approval` is refused as well. The `bin/board-cli` wrapper maps any non-zero exit of
`guard` to exit 2, for a failure before the guard's own code runs; other commands keep `exec` and
their exit status.

**The runner's code fingerprint.** Hooks run the main checkout's current code, while the daemon
keeps the code it started with, so a pull that changes the hooks' contract would break phases
until a restart. The fingerprint is a SHA-256 digest over the `.ts` files under `runner/src`
(recursively) and `runner/bin/board-cli`, in sorted relative-path order, each as its path and its
content. It reads the files as they are on disk, so uncommitted edits in the main checkout count,
and it makes no `git` call. Nothing else counts: a non-`.ts` file under `runner/src`, `runner/tests`,
`node_modules`, `.env`, `server/`, `web/`, and any other checkout or task worktree. The daemon
computes it once at start and gives it to every phase process as `BOARD_RUNNER_CODE`.

- **The guard** computes the fingerprint at its own location before it decides a call. When
  `BOARD_RUNNER_CODE` is unset, empty or different, it denies the call: the runner's code changed
  since the runner started the phase, so no tool call is allowed, and the agent should end its turn
  and say so. A fingerprint that cannot be computed is a guard failure, refused as above. The
  event hook is unchanged: it records events, writes the pause marker and gives the files
  feedback whatever the value.
- **The `runner code check` block.** Before spawning a phase process, and again when one ends of
  its own accord (before its result is acted on), the daemon computes the fingerprint. When it
  differs from the start value, no process starts (before) or the result is dropped (after), a
  `code-moved` marker is written in the run directory, and the run is blocked as `step_failed`
  with the command `runner code check` and an output saying the code changed, that the runner
  restarts itself once it has no run in hand, and that Resume then continues the run. The
  checkpoint keeps the phase's session. A process that was paused, cancelled or stopped by a
  shutdown is handled as before. Resume on the restarted daemon continues the same session and
  starts its message with one line: the runner restarted on its new code since the agent's last
  turn, and tool calls work again. That line comes before the base-moved note and the message, is
  added outside the checkpoint's message, and is sent only when the marker exists; the marker is
  deleted once the process is spawned, a new session included.
- **The idle self-restart.** Before each claim the daemon reads the fingerprint. A read equal to
  its start value ends the check. Only a differing read is followed by a wait of 2 s and a second
  read; the code has moved when both agree. A read that fails, as one does when a pull removes a
  file between listing and reading it, counts as differing and never agrees, so the daemon goes
  on; around a phase process, such a read counts as moved code and blocks the run as below. A
  daemon whose code moved claims nothing, logs a
  `board-cli: ` line, and exits with status 75. A daemon whose code has not moved never exits for
  this reason.
- **The handoff.** Right after a claim returns a start or a resume, the daemon makes the same
  check. When the code has moved it writes `<BOARD_HOME>/handoff.json` (one write to a temporary
  name, then a rename) holding the claimed work and the time the claim returned, logs a
  `board-cli: ` line, and exits 75 without carrying the work out. A claimed cleanup is never
  handed on: the old daemon carries it out itself, and the check before its next claim makes it
  exit. A starting daemon that finds the file deletes it first, then, if it holds a start or a
  resume claimed less than 60 s ago, sends one heartbeat for the run. A heartbeat that does not
  list the run in `cancel` is followed by carrying the work out as if just claimed; one that does
  discards it with a log line. A file that cannot be read or parsed, one holding other work, or
  a claim 60 s old or older is discarded with a log line naming the reason; the sweeper then
  blocks the run as `runner_lost` and Resume continues it. The daemon then claims as usual.
- **The wrapper's loop.** `bin/board-cli daemon` runs the daemon in a loop, as a child it waits on.
  Exit 75 starts it again at once; exit 0 ends the wrapper with 0. Any other exit ends the wrapper
  with that status if the wrapper has not yet restarted the daemon. Once it has restarted it
  (after a 75), the wrapper logs `board-cli: the runner's code did not start (exit N); retrying in
10 s` and retries every later failure, not only the first, since a pull caught half done fails
  until it finishes. SIGINT or SIGTERM sent to the wrapper alone or to its process group reaches the
  daemon as SIGTERM, so it blocks its run, and ends the loop, during the daemon or during the wait. The script's whole body is one function and its last line calls it and
  exits, so a pull that rewrites the file while the loop runs leaves the shell nothing to read.
  `guard` keeps its mapping of any non-zero exit to 2.

Editing a file under `runner/src` or `bin/board-cli` in the main checkout, or switching its
branch, blocks any phase in flight at its next check and restarts an idle daemon. The first
daemon after this change is started by hand: one from before it never sets `BOARD_RUNNER_CODE`.

A present but malformed `allowed-files.json`, `approved-migrations.json` or `excluded-paths.json`
also fails a delivery run. In the `tests` stage the files gate reads all three before the test
command, so the run ends `failed` with the reader's message as its reason and the command does not
run. A Verify started afresh after a resume reads only `excluded-paths.json`, after the test
command has run, and ends the run the same way; a malformed `allowed-files.json` or
`approved-migrations.json` there is met by the guard instead, which refuses Verify's every tool
call. A missing file keeps its meaning (no plan, no approvals, no exclusions).

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
and focuses it. A request's context is rendered Markdown, headings starting at `h4` (`h5` for a batch
question's); a plan's checks read as a table. A migration's stays plain code. The header's count of waiting
questions is text, not announced.

A batch is one form: per question a `section` under an `h4`, "Question <i> of <n>", holding the
kit's `RadioGroup` named by the question when it has options, and a field "Your answer to
question <i>"; then one Send answers. Choosing sends nothing. A send with questions unanswered
marks each — the radio group when it has options, so the radio that takes focus is described by
the error, else the field — and focuses the first: its first radio, or its field.

The Spec tab opens on the task's Description, with Save description, in Backlog and Spec review,
then the Version select and the spec formatted: Markdown rendered by the kit's `Markdown`
component under an `h3` "Spec v<n> · <status>", with raw HTML shown as text and only `http`,
`https` and `mailto` links kept. A card with no version says "No spec yet."; in Backlog it offers
Write spec and Draft spec. In Spec review the formatted view is followed by the version's Lint
section, and the actions Edit and Approve; What to change with Redraft follow. Edit (or Write spec)
opens the editor, a textarea holding the unsaved draft or the shown version, with Save as
v<latest + 1>, Preview and Discard changes. A draft exists while the editor's text differs from
its baseline; without one Save as is disabled and says why. While a draft exists the Version select,
Redraft and Draft spec are disabled with their reason beside them, and Preview shows the draft
formatted as "unsaved changes" in place of Lint, with Approve disabled. Saving, Preview and Discard
move focus to Edit (to Write spec when no version exists). In every state after Spec review, and in
Spec draft (which says so), the spec is only read. An empty description or note marks its field
invalid and focuses it. The card announces a draft ready to review with its
version, read afresh, and a draft that did not finish with its reason, which also stands under
its state line. `tests/ui/` scans every state it reaches with axe-core and drives the board, the
card, an answer and a batch by keyboard alone.
