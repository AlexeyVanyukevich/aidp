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
tokens left by stray separators are ignored. The verifier gives every criterion one of three
verdicts through `save_report`: `pass` or `fail` for an ordinary criterion, and for an owner check
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

  The claim also carries `plan_answers: { run, approved, text }[]`, the owner's words at earlier
  plan gates: the answered `plan` approvals of the task's other delivery runs on the same spec
  version whose answer text is not blank, oldest answered first (ties by approval id), with the
  text trimmed; `approved` is true exactly when the answer chose Approve plan. It is empty
  wherever `previous_plans` is empty, and an older board's absent field counts as empty. Only
  the Plan phase's handoff carries them, one `<plan_answer run="<n>" approved="yes|no">` tag
  each after the `<previous_plan>` tags. Their trimmed texts total at most 20,000 characters,
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
to the allowed list for the rest of the run.

_The files gate._ The guard checks only the file tools, so a change written through `Bash` (a
script, `sed -i`) is checked afterwards, on what the worktree holds. At the start of the `tests`
stage, before the commit count and the test command, the runner lists the paths the branch
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
holds those paths: right after the setup command in `prepare` it is set to the uncommitted list,
and around each run of the test command the runner adds every uncommitted path that the run
created. Exclusions apply to the uncommitted list only and go by path; a committed path is never
excluded, so committing `git add -A` output of setup is a violation. Files the builder's own
commands create before the runner's first test run are not excluded: on attempt 1 they count
until the builder deletes them, which is the cost of a builder that runs the tests itself.

_Feedback on Bash._ After each `Bash` call in Build, the PostToolUse hook runs the same
computation and, with any violation, writes `{"decision":"block","reason":…}` with the report's
text, so the builder learns at once, with the commands that undo it (`git checkout <hash> -- <path>`
with the merge-base's full hash, `git rm`, deleting a generated file). In every other case
(another phase or tool, no violation, no `allowed-files.json` yet, or a failing git command or
run-directory file) it writes nothing; it records its event and exits 0 whatever happens.

_A git failure._ A `GitError` in the gate blocks the run at the `tests` stage with `step_failed`;
the test command does not run, and Resume runs the gate again.

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
a migration. The files gate holds a migration the owner has not approved to the same rule for
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

New migrations, and changes to migrations from the base branch, need the owner's approval. A new
migration whose name sorts at or before a sibling's, in the worktree or on `origin/<base>` as last
fetched, is refused by the guard and by the `migration` request, never put to the owner; see
"Migration approval".

No sign-in: the server binds 127.0.0.1, answers only to `ALLOWED_HOSTS`, and refuses writes
from a foreign `Origin`. The runner authenticates with `RUNNER_KEY`; each `claude` process gets
a run token limited to its run, retired five minutes after the process exits. Runner credentials
are checked before a request's body is read. The guard denies `rm -rf`, `git push`,
`git reset --hard`, `.env` files, paths outside the worktree, in Build any file the run has not allowed, `Bash` or `Agent` sent to the background (`run_in_background: true`,
which a `-p` process loses when its turn ends), and — once the run is paused — every tool. In every phase it also denies `git commit` with
`--no-verify` or `-n` (alone or inside a cluster such as `-an`), and `git -c core.hooksPath=…
commit`, with a reason saying the commit-msg hook must not be skipped; text inside a `-m` value
never matches.

The guard sees what a tool is asked to do, not what a `Bash` command writes, so Build's file list
is also checked on the worktree: by the files gate before the test command, and by the PostToolUse
hook after each `Bash` call (see "Out-of-plan edits"). Both read the changed paths through `git`
with `-z`, and nothing is fetched. Before the push, the runner compares the worktree's `HEAD` with
the one recorded when the gate passed; if Verify committed, the run ends `failed` with `Verify
changed the branch: HEAD is <sha>, Build ended on <sha>` and nothing is pushed (a run started
before the gate existed has no record and pushes as before). A `Bash` write outside the worktree
is not caught.

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
