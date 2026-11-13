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

Every move runs in a transaction: `moveTask` takes only a `Transaction`, locks the task row with
`for update` before it checks the move is legal, and holds the lock to the commit, so a move that
conflicts with one committed meanwhile waits and then fails with a `409 conflict` instead of
overwriting it. The same transaction settles the task's decision helps (`settleHelps`). This holds
for the PR poller's merge and close and for the owner's drag to Done and Mark done as for every
other move; the poller logs a `ConflictError` on one card ("the PR poller could not move a card",
with the task's id, its key and the move) and goes on to the next card in the tick.

Every move goes through `server/src/modules/tasks/transitions.ts`, a pure table; nothing else
writes `tasks.state`. Where a destination depends on the latest run's kind or on whether the task
has a spec, the caller reads those facts (`moveFacts`) and the table picks the state. The
description can change only in Backlog and Spec review.

## Prioritising the board

The board head has a **Prioritise** button, after the New task form. `POST
/api/projects/:key/tasks/reorder` takes no body (an empty object is accepted; any field answers 400
`validation_error`) and renumbers every column, Done, Blocked and Failed included, to the positions
1, 2, … n, keeping each column's order by position and then by task number. The rule is the pure
`renumber` in `server/src/modules/tasks/task.reorder.ts`. It runs in one transaction that first
locks the project row, so a task being created is numbered too, then the project's task rows
`FOR UPDATE`. It writes `position` and `updated_at` only on the rows whose position changes, and
never writes `state`. It publishes `task.updated` for each changed row inside
the transaction, so the notices go out at commit and never after a rollback, and answers
`{ "reordered": n }`, the number of rows changed. An unknown project answers 404.

The button sends no confirmation and sets `busy` while the request runs; it is always enabled and
focus stays on it. The outcome goes to the board's status region: "n tasks reordered.", "1 task
reordered.", "The tasks were already in order.", or "The board could not be reordered. Try again.";
the board is refetched either way. With no cards it sends nothing and says "There are no tasks to
reorder."; before the board has loaded it says "The board has not loaded yet.". Each of these is
announced again on a repeated press: the region is emptied, stays empty across two animation
frames, and is then refilled, with at most one write pending and the board's own writes cancelling
it. `web/src/announce.ts` is the one place this rule lives, shared with the Spec tab. The refill
fills the region only if it is still empty, so a message written in between is never overwritten.

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

## Reading the board from a run

The spec writer, the planner and the helper can read the whole board, every project and not only
the task's own and its linked ones, with three tools. The builder and the verifier have two of
them, `list_tasks` and `read_task`. They only read: no row is written and nothing is published.
Their tokens (run tokens and helper tokens alike) reach them; the title writer and rephraser do
not have them. The tool lists, besides Read, Grep, Glob and (planner, verifier) Agent, are:

- spec writer: `get_task`, `get_spec`, `list_projects`, `list_tasks`, `read_task`,
  `propose_task`, `list_proposals`, `save_spec`, `log_step`, `request_approval`;
- planner: the same with `save_plan` for `save_spec`;
- builder (with Edit, Write, Bash): `get_task`, `get_spec`, `list_tasks`, `read_task`,
  `propose_task`, `list_proposals`, `log_step`, `request_approval`;
- verifier (with Bash): `get_task`, `get_spec`, `list_tasks`, `read_task`, `propose_task`,
  `list_proposals`, `save_report`, `log_step`, `request_approval`.

- `list_projects` takes no input and returns `[{ key, name }]`, ordered by key.
- `list_tasks` takes `project`, a project key, and an optional `filter`. It returns
  `[{ key, title, state }]` for every task of the project in every state, ordered by number; a
  project with no tasks gives `[]`. The filter is trimmed; when it is then not empty, only tasks
  whose title or description contains it as a case-insensitive, literal substring are kept (`%`,
  `_` and `\` match only themselves; the match is `lower(...) LIKE lower(...)` with an explicit
  escape character on a bound parameter). An absent or blank filter keeps every task.
- `read_task` takes `key`, a task key matching `^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$` once upper-cased. It
  returns `key`, `title`, `state`, `description_md` and `spec`: the task's highest spec version as
  `{ version, status, body_md }`, with the stored status (`draft`, `approved` or `superseded`), or
  `null` when it has no spec.

The tools fold case: `project` and `key` are upper-cased before they are checked, so `zlr` finds
ZLR, and every key in a reply is upper case. The HTTP routes do not fold case: `GET
/api/projects/zlr/tasks` is still a 404. An error reply (`isError`) names the upper-cased key and,
for a project that does not exist, lists the valid project keys. `read_task` answers with an error
for a malformed key, an unknown project, and a number the project has no task for.

**Saved results.** Claude Code saves a tool result that is large enough, such as a long spec from
`read_task`, to a file under `<config dir>/projects/.../<session id>/tool-results/` and answers
with the file's path. `<config dir>` is `CLAUDE_CONFIG_DIR` when it is set and not empty, and
`~/.claude` otherwise (`runner/src/phases/config-dir.ts`, used by both rules below). The run
directory's `settings.json` carries one `permissions.allow` rule for it,
`Read(//<config dir>/projects/**/tool-results/**)`. The guard narrows the rule in every phase to
the calling session's own results: the directory comes from the hook input's `transcript_path`
(its directory, the transcript's name without `.jsonl`, then `tool-results`). A Read inside it is
allowed, in a help too; a Read elsewhere under `<config dir>/projects/` is refused, as is any
Read when the hook input has no `transcript_path`. Only Read reaches saved results: a Grep or Glob
whose path (or a Glob's absolute pattern) lies under `<config dir>/projects/` is refused, since a
saved result is one line of JSON. Paths are resolved before they are compared. A subagent's saved
results are not covered.

The spec writer's and planner's instructions tell each to search the board with `list_tasks`
over the task's own project, every project in `<linked_projects>` and every project key the
description names, and to name related tasks: the spec writer in `## Context` with the projects
searched, the planner in its summary, saying whether the plan takes each in or leaves it out. The
helper's instructions tell it to settle whether a task exists from the board, not to report it as
unsure.

## Proposing a finding

A finding outside the task, such as a bug noticed on the way past or a document that has drifted,
reaches the board as a **proposal**. No agent creates a task: the owner settles each proposal on
the card, and only then does a task exist. The spec writer, planner, builder and verifier have two
tools for it, registered for run tokens only (never for a helper's, the title writer's or the
rephraser's).

- `propose_task` takes `project`, `title`, `description_md`, `related`, and optionally
  `bearing_md` and `workaround_md`. `project` is the task's own project or one it links to in
  `project_links`, read when the call is made, with case folded as `list_tasks` folds it; any other
  key is an error reply naming the upper-cased key and the allowed keys, ordered by key. The title
  is trimmed and must then be 1–200 characters. The description must carry the labels Where, Found,
  Problem and Impact, either `**Where:**` or `**Where**:`, case-sensitive, each at the start of the
  description or of a line after at most one list marker; the reply names each missing label and
  the expected form. With the proposed-by line added the description may not pass 100,000
  characters. A title equal (trimmed, case-insensitive) to a task of the target project in any
  state, to a proposal of this run to it whatever its outcome, or to an open proposal of another
  run to it is refused, naming the task's key and state or the proposal, its outcome and run
  (`Draft n` or `Run n`, with the task key for another run's).
- `bearing_md` (at most 2,000 characters after trimming) says how a related finding bears on this
  task, and is required then; for an unrelated finding it says why it came up, is optional, and is
  stored as null when blank. `workaround_md` (1–10,000 characters) belongs to a related proposal.
- Nothing is saved when no phase of the run is running, the run is neither a spec nor a delivery
  run, the running phase is none of spec, plan, build and verify, or the rules above refuse.
  `related` is refused in build and verify: every finding proposed there is unrelated, and a
  blocker goes through `request_approval`. A delivery run never waits on a filed task once Plan
  has ended. A run makes at most 10 proposals, counted whatever their outcome; the 11th is refused
  with a reply that tells the agent to list the remaining findings in its report or summary.
- `list_proposals` takes no input and returns the task's proposals as the HTTP route gives them
  (below), for every spec and delivery run of the task, whatever the state of the run's phases.

**Two kinds.** An _unrelated_ proposal leaves the run running and holds nothing back: Approve,
Approve plan, the pull request, Mark done and the drag to Done behave as they do without it, and it
can be settled in any task state, Done included, after its run has ended. A _related_ proposal is
opened through `openApproval`, in the same transaction, as an approval of kind `proposal` whose
question is the title: the phase, the run and the card pause (Needs approval), the reply is the
paused reply, and the one-open-request rule holds in both directions. After 48 hours the sweeper
expires it and the card goes to Blocked with cause `approval_expired`; settling it from Blocked
resumes the run as answering an expired question does. Cancel withdraws its approval and the
proposal stays open.

**Settling.** `POST /api/tasks/:id/proposals/:proposalId/settle` with `{ "variant": … }` (strict
body; `file`, `workaround`, `wait` or `dismiss`). A proposal of another task is 404; a settled one
409 `settled`; a variant the proposal does not offer now, `wait` always, 409 `not_offered`; a
`file` or `workaround` whose title now equals a task of the target project 409 `duplicate`, naming
its key and state. An unrelated proposal offers File and Dismiss. A related one offers File, then
Use the workaround and file when it has a `workaround_md`, then Dismiss, while its approval is open
or expired; once Cancel has withdrawn the approval it offers File and Dismiss. The outcome `wait`
is in the vocabulary and the schema and is not offered yet.

The settle is one transaction: the numbering bump and the new task in the target project's
Backlog, at the bottom (`TaskRepository.insert` joins the caller's transaction), the proposal's
outcome, `settled_at` and filed task, a declared `message` event, for a related proposal with an
open or expired approval the approval answered, the card moved and a resume queued, and the
settling of the proposal's helps. Its notices (`task.updated` for the new and the proposing
task, `run.event`, `run.queued`, `help.updated`) go out at commit, never after a rollback. The
filed task's description is the proposal's text, a blank line and `Proposed by <task key>, <run
label>, <phase>; filed by the owner.` (for `workaround` the line ends `filed by the owner, and
<task key> goes on with a workaround.`). The resume message tells the agent what was filed
(`The owner filed KEY-n: <title>. Go on with the task unchanged, and name KEY-n in your
summary.`), what was filed with the workaround to carry into the spec or plan, or that the
proposal was dismissed. Proposing and settling each write a declared `message` event on the
proposal's run and phase (`Proposed: <title>`, `Filed KEY-n: <title>`, `Filed KEY-n with the
workaround: <title>`, `Dismissed: <title>`); the settle events have no agent. The Timeline shows
them and `get_phase_record` returns them to a helper. They do not count toward the cap.

**Lock order.** One order serves the proposal tools, the settle and Cancel: the proposal row, the
target project's row, the proposing task's row, the run row; each takes those it needs. `propose_task`
locks the project, the task and the run before it reads the cap or the titles, so two concurrent
calls cannot pass the cap or save one title twice. A settle locks the proposal, then for `file` and
`workaround` the project, then for a related proposal the task and the run. Cancel locks the task
then the run, as it always did, and Prioritise locks the project before its tasks, which this order
keeps. Every other lock (the approval row, the phase row, `moveTask`'s task row, the helps rows)
comes after these.

**HTTP.** `GET /api/tasks/:id/proposals` returns every proposal of the task's spec and delivery
runs, newest run first and then by number: `id`, `run` (`{ kind, number }`), `phase`, `number`,
`project`, `title`, `description_md`, `related`, `bearing_md` (null when none), `workaround_md`,
`offered` (empty once settled), `outcome` (null while open), `filed_task` (`{ id, key, title }` or
null), `created_at` and `settled_at`. An unknown task is 404. `POST /api/approvals/:id/answer` on a
`proposal` approval is 409 `settle_proposal`; the approval counts as not current for the question
decision, so it offers no question helps, and `POST /api/approvals/:id/helps` on it is 409
`not_offered`. The task view's `approval` still names it.

**The verifier and a task on the board.** A criterion that requires a task on the board passes when
`list_tasks` finds a matching task in the target project, or `list_proposals` shows a matching
proposal of any run of the task that is open or filed (outcome `file` or `workaround`). A dismissed
proposal never counts, and with neither the criterion fails. The four prompts say to propose, never
to file; to search with `list_tasks` and read `list_proposals` first; to use `propose_task` rather
than the HTTP API, the `curl` line in the repository's Findings rule being for sessions outside a
run; to name each proposal in the summary or report; and to list the remaining findings there once
the cap refuses one. The spec writer and planner are told a related proposal pauses the run and to
give a workaround when there is one. The builder and verifier are told every finding is unrelated.
A fix that must land first is the owner's to arrange: cancel the run and use Re-run and plan again,
whose Plan starts from the current base.

**The card.** The Proposals tab follows Approvals. It lists one `h3` per run (`Draft n` or `Run n`)
and under it a card per proposal labelled by its `h4`: a `related` or `unrelated` badge, an outcome
badge (`open`, `filed`, `filed with workaround`, `dismissed`), `To <KEY> · proposed in <phase>`, a
link to the filed card, `How it bears on this task:` (related) or `Why it came up here:`
(unrelated) with the text, a `Description` and a `Proposed workaround` disclosure, and for an open
proposal the buttons `File in <KEY>`, `Use the workaround and file in <KEY>`, `Dismiss` and `Suggest
how to settle`, each described by the `h4`. The `h4` has `tabIndex` -1 and takes focus only by
script, after a settle. A settle button is busy while its request runs; on success the buttons go,
focus moves to the `h4`, and the status region says `Filed KEY-n: <title>.`, `Filed KEY-n with the
workaround: <title>.` or `Dismissed: <title>.`. A proposal arriving while the card is open is
announced once as `New proposal: <title>.`. An error goes into the problem region, which takes
focus, and the list is refetched: `This proposal was settled meanwhile; its latest state is shown.`,
`<KEY-n> (<state>) already has this title. Dismiss the proposal, or file the task by hand under
another title.` or `That did not work. Try again.`. With no proposals the tab shows `No proposals`.
A card waiting on a `proposal` approval opens on this tab, and the Approvals tab shows it as one
paragraph, `<agent> proposed a task: <title>. Settle it on the Proposals tab.`, with no form.

**Help.** Settling is a decision control. The decision `proposal` has the one mode `advise`; it is
offered for each open proposal, its subject is `{ proposal_id }`, and it stands while that proposal
is open. `POST /api/tasks/:id/helps` takes `proposal_id`, required with `proposal` and refused with
any other decision (400, naming `proposal_id`); a settled or unknown proposal is 409 `not_offered`,
and a press while that proposal's help is in flight answers with it. Settling stops its queued and
running helps and retires its succeeded one in the settle's transaction. The helper works from the
base checkout (`Decision: proposal. Mode: advise.`), reads `get_decision` (the proposal, its run,
the proposing phase and `offered`) and the newest 300 entries of the proposing phase from
`get_phase_record`, searches the target project with `list_tasks`, and saves `variant` (one the
proposal offers now), `reasoning` and `unsure` with `save_help_result`. The result shows under
`Suggested settlement`, with `Suggested:`, `Why:` and `Unsure about:`.

**Storage.** Migration 012 creates `proposals` (cascading from run, phase and task; the target
project and filed task are restricted) with checks that tie the outcome to `settled_at` and to the
filed task, a related proposal to its approval and bearing, and a workaround to a related
proposal, and rewrites the three `helps` checks to add the decision. Its `down` refuses while any
proposal or proposal help exists.

## A spec run

**Draft spec** queues a spec run; **Redraft** queues one carrying the latest version and the
owner's note, which may be at most 4,000 characters: a longer one is refused with "The note is
longer than 4,000 characters." beside the field, a blank one with "Say what to change.", and focus
goes to the field. Spec runs and delivery runs are numbered apart: "Draft 2", "Run 1", and the
delivery branch `board/<KEY>-r<n>` counts delivery runs only. Claiming a spec run moves no card,
and one whose card has left Spec draft is cancelled at claim.

In a redraft note, a line that begins after its indent with "Open choice, ask me:" leaves the choice
under the line before it to the owner: the spec-writer asks about it in its batch of questions,
offering the line's choices as options without the "(recommended)" mark and giving the marked one
as the question's recommendation, and never decides it. A line that begins with "Decision:" is the
owner's decision on the finding above it, and the writer follows it.

The runner (`runner/src/drafting.ts`) checks out a detached worktree of `origin/<base>` — no
branch, nothing is pushed — then runs one phase, `spec`: the spec-writer on Opus at high effort,
with Read, Grep, Glob and the board's `get_task`, `get_spec`, `list_projects`, `list_tasks`,
`read_task`, `save_spec`, `log_step` and `request_approval`. Its handoff carries the task's description, and for a redraft the version and
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

## A title run

**Rephrase title** on the Spec tab queues a run of kind `title` for a card in Backlog or Spec
review; the card does not move, and neither does any other run's state, phase or numbering:
every lookup of "the task's latest run" (`moveFacts`, the card's approval, block and draft
failure, Cancel run, the board card's phase and PR) ignores `title` runs. Title runs are numbered
among themselves ("Title 1" in the Timeline, whose phase band and Cost row read "Title") and are
priced like any phase.

A title run has a claim lane of its own. `POST /api/runner/claim` takes an optional `kinds` list,
which defaults to `spec` and `delivery`, so a title run goes only to a claim that names it; the
daemon's main loop claims `spec` and `delivery`, and a second loop claims `title` and
`rephrase` only, so a title or rephrase run starts while another task's run is in progress. A queued title run whose card has left
Backlog and Spec review is cancelled at claim. Cleanup rows go to the lane of their run's kind.
Once either loop sees the runner's code move, neither sends a new claim request; the daemon waits
for each open claim request (at most the claim wait), hands on a main-lane start or resume,
carries out a cleanup, and ends a title claim failed with "the runner stopped" (a title claim is
never handed on), stops a title run in flight the same way, and exits 75. While the main loop
carries a run, a title lane that saw moved code claims nothing until the restart. The two lanes
share one `Git`, which runs the steps that change a repository's remote refs or worktree list
(fetch, worktree add, prune and remove, branch delete) one at a time per repository, since two
fetches of one base collide on its ref lock; steps in different repositories still run at once.

A help lane carries helps beside both. Once the code has moved, the guard refuses every tool call,
the result-saving one included, so a running help could not finish: the daemon stops each running
help's process at once and reports it failed, "runner restarted", which closes its Help phase
failed and interrupted. A help claimed after the move is given back with
`POST /api/runner/helps/:id/release`, which queues it again for the new daemon's claim. Helps are
never handed on through `handoff.json`, so they cannot lose or delay a handed-on start or resume.

The runner checks out a detached worktree of `origin/<base_branch>` and runs one phase, `title`,
with the agent `title-writer` on Sonnet at medium effort. Its tools are Read, Grep, Glob and the
board's `get_task`, `suggest_title` and `log_step`: no edit, Bash, Agent or `request_approval`, so
it never asks the owner. `suggest_title` takes a one-line `title` (1–200 characters) and a
one-line `reason` (at most 300), is refused outside a running title run, and stores one artifact
of kind `title` with `data` `{ title, reason, decision: null }` that later calls in the run
rewrite. It changes no task field.

A title run is never paused, blocked or resumed. The runner ends it `suggested` when the phase
succeeded; the server then marks the run succeeded if an artifact was stored, and otherwise failed
with "the title agent suggested no title". A failed phase fails it with "the title phase failed",
a cancel ends it cancelled, a stopped daemon fails it with "the runner stopped", and the sweeper
fails a run with no heartbeat for 90 seconds with "the runner was lost". A phase a cancel or a
stop left open ends failed and interrupted with the run. None of these moves the card. A failed
run's runner learns of it in its heartbeat's cancel list and stops its process.

The task view carries `title_suggestion`, read from the latest title run: `working` while one is
queued or running, `ready` with the title and reason while its artifact is undecided, `failed`
with the reason, otherwise `null`. Four actions serve it, each answering 409 outside Backlog and
Spec review (stop-title excepted): `rephrase-title` (also 409 while a title run is queued or
running), `stop-title` (cancels a queued run at once, or asks the runner to stop a running one),
`accept-title` with `{ title }`, which sets the title to that text and the artifact's `decision` to
`accepted` in one transaction, and `discard-title`, which sets `discarded`. `PATCH /api/tasks/:id`
changes `title` only in those two states.

The Spec tab opens with a Title field above Description, with Save title and Rephrase title; in
other states the field is read-only. While a run works, Rephrase title gives way to "Suggesting a
title…" and Stop; a ready suggestion shows an editable "Suggested title" field with its reason as
the hint, Accept title and Discard. An edited, unsaved title is saved first. The status region
announces "Suggesting a title.", "A title is suggested: …", "Title saved.", "Suggestion stopped.",
"Suggestion discarded." and a failure; Rephrase title moves focus to Stop, Stop and a finished run
return it to Rephrase title, and Accept title and Discard move it to the Title field. An empty
title shows "Enter a title.", is marked invalid and takes focus.

## A rephrase run

**Rephrase description** on the Spec tab suggests a clearer description from the project's code.
`POST /api/tasks/:id/actions/rephrase` queues a run of kind `rephrase` for a card in Backlog or
Spec review; it holds the description as it stood in `runs.base_md`, is numbered among the task's
rephrase runs ("Rephrase 1" in the Timeline, whose phase band and Cost row read "Rephrase"), and is
priced and bound by `budget_usd` like any run. The card does not move, and every lookup of "the
task's latest run" reads only spec and delivery runs, as for a title run. The request is `409` in
any other state or while a rephrase run is queued or running, and `400 validation_error` with
`details.field` `description_md` when the description is blank. Queuing marks the task's pending
suggestion `replaced`.

A rephrase run uses the title lane (claim `kinds` accepts `rephrase`) and the title run's rules:
a queued run whose card has left Backlog and Spec review is cancelled at claim; the run is never
paused, blocked or resumed. The runner checks out a detached worktree of `origin/<base_branch>`
with the linked checkouts and no setup (stages `prepare`, then `rephrase`), creates no branch,
pushes nothing and removes the worktree when the run ends. It runs one phase, `rephrase`, with the
agent `rephraser` on Sonnet at medium effort in default permission mode. Its tools are Read, Grep,
Glob and the board's `get_task`, `save_suggestion` and `log_step`: no edit, Bash, Agent or
`request_approval`. The handoff carries the key, the title and `base_md` as the description. The
prompt tells it to read the code, rewrite the description clearly, add which code is involved,
what it does today and what the change touches, keep the owner's intent and decide nothing the
owner did not, say where it is unsure, suggest the description only, change no file and finish
with one sentence.

`save_suggestion` takes `body_md` (1–100,000 characters), is refused outside a rephrase run and
when its phase is not running, and writes `runs.suggestion_md`; a later call overwrites it. It
answers "Saved the suggestion." and changes no task field. The runner ends the run `suggested`
when the phase succeeds; the server then marks it succeeded with `suggestion_status` `pending`,
or fails it with "the rephraser saved no suggestion". A failed phase fails it with "the rephrase
phase failed", a cancel ends it cancelled, a stopped daemon or a failed git step fails it ("the
runner stopped", "the rephrase run could not go on: …"), and the sweeper fails a run with no
heartbeat for 90 seconds with "the runner was lost", interrupts its phase and queues a cleanup.
A phase a cancel or a stop left open ends failed and interrupted with the run, and a `run_end` that
arrives after the run has ended changes nothing. None of these moves the card.

While a rephrase run is queued or running, `draft-spec`, `redraft` and approving a spec answer
`409 conflict` with `details.reason` `rephrasing`; saving the description and saving a spec by
hand stay allowed. `POST /api/tasks/:id/actions/cancel-rephrase` cancels a queued run at once, or
sets `cancel_requested` on a running one, whose runner reports `cancelled`; it is `409` with none
in flight. `POST /api/tasks/:id/suggestion/accept` with `{ description_md }` (1–100,000
characters and not blank, the suggestion as shown, edited or not) sets the description and marks the pending
suggestion `accepted` in one transaction; `POST /api/tasks/:id/suggestion/discard` marks it
`discarded` and leaves the description. Both are `409` outside Backlog and Spec review or with no
pending suggestion.

The task view carries `rephrase`, read from the latest rephrase run: its `status`, its
`failure_reason` when it failed, and while a suggestion is pending `suggestion` with `body_md` and
`stale`, true when the description now differs from the run's `base_md`.

The Spec tab shows **Rephrase description** beside Save description in Backlog and Spec review. An
edited, unsaved description is saved first; a blank one is marked invalid with "Write a
description first; the rephraser works from it." and takes focus. While a run is in flight the
button gives way to "The rephraser is reading the code." and **Cancel rephrase**, and Draft spec,
Redraft and Approve are disabled and described by "Wait for the rephrase to finish, or cancel
it." A pending suggestion appears beside the Description, stacking below it at narrow widths,
under the heading "Suggested description", in an editable "Suggestion text" field with **Accept
suggestion** and **Discard suggestion**, and "Written from an earlier version of your
description." when stale. Accept with the field blank sends nothing: the field is marked "Write
the text to accept, or discard the suggestion." and takes focus. A failed run shows "The last rephrase did not finish: <reason>." until
the next starts; a cancelled one shows nothing. The status region announces "A suggested
description is ready.", "Description replaced with the suggestion." and "Suggestion discarded.";
Rephrase description moves focus to Cancel rephrase, and Accept, Discard and Cancel rephrase move
it to the Description field. These controls have not been tried with a screen reader or at 200%
zoom.

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
the third ends the run `failed` with "verify failed three times" (a failing test command is not a
criterion failure: see "The tests stage on the current base"). The owner sees what is left to
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

**Helps.** While a request is current — open, or expired on a Blocked card — each of its
questions, for all five kinds, offers **Suggest an answer** and **Explain simply**. A press
records a row in `helps` (mode, status `queued`) and moves nothing else: the run, the asking
phase and the card stay as they were, and `resume_message` is untouched. A press while a help of
that mode is queued or running starts nothing more. The runner carries up to three helps beside
the run it is carrying: `POST /api/runner/helps/claim` takes the oldest queued one, whether or not
the run slot is busy, and each help process sends its own heartbeat. A help is its own Claude Code
session, on Opus at high effort, in the asking run's worktree, with its own run directory and a
token limited to the run (`run_tokens.help_id`) that reaches only the helper's tools: Read, Grep,
Glob, `get_task`, `get_spec`, `list_projects`, `list_tasks`, `read_task`, `get_question`,
`get_decision`, `get_phase_record` and `save_help_result`. The guard
refuses everything else. `save_help_result` refuses an option the question does not offer, a
suggestion with neither option nor words, and an explanation carrying an option, naming the field;
a saved result moves the help to `succeeded` and the card shows it without a reload. A help that
ends without a result, or whose process sends no heartbeat for 90 seconds (the sweeper), is
`failed`, and the sweeper also closes its Help phase. Answering, Cancel and withdrawal mark the
request's queued and running helps `stopped`; the next heartbeat ends the process, and a save from
it is refused. Nothing a help produced reaches the asking agent except through the answer the
owner sends. Each help is a phase named `help` on the asking run: its usage is priced into the
task's cost, and it is never the run's current phase, a checkpoint's phase, or in a handoff's
summaries. Approving a plan with words is refused, naming `text`.

**Decision helps.** The card's own decisions offer help beside a question's. The registry is
`server/src/modules/approvals/decision-rules.ts`, pure and free of the database; it lists each
decision, its modes and when it is offered, and `tests/fixtures/decisions.json` is the table that
the server's rules and the web's `actionsFor` and `decisionsFor` are all tested against.
`spec_review` (modes `review`, `restate`) is offered in Spec review; `stopped_run` (`recommend`)
on a Failed card, or a Blocked one whose cause is not `approval_expired`; `mark_done` (`check`) in
Backlog, Spec review, Review and Failed; `pull_request` (`code_review`) in Review when the latest
delivery run has a pull request (`hasPullRequest`, shown to the web as `has_pull_request`). `POST /api/tasks/:id/helps` takes `{ decision, mode }`:
inside one transaction it takes the task row lock that `moveTask` takes, checks the decision is
offered (`409 not_offered` when it is not), and records a `helps` row with a **subject** (the spec
version; or the stopped run, the task state and the block; or the task state, spec version and
delivery run) and a run of its own of kind `help`. A press while a help of that decision and mode
is queued or running answers with it.

A `pull_request` help's subject is `{ pr_run_id }`, the latest delivery run's id when it was asked.
It stands while the decision is offered and that run is still the latest, so a push to the branch
outside the board does not retire it: the owner presses Review pull request again to review the new
head. A review runs only when the owner asks. It is never posted to GitHub: helpers are read-only,
and the board runs exactly three `gh` commands, `pr view`, `pr list` and `pr create`. The server's
`realGh` and the runner's `Git.run` check the first two arguments against that list before they
spawn anything and refuse any other with "the board does not run gh <first> <second>".

A `help` run never has status `running` and is never claimed through `POST /api/runner/claim`
(which refuses `help` in `kinds`): it is `queued` with a null `queued_at`, and it ends in the
transaction that ends its help — `succeeded` on a result, `failed` with the help's reason, or
`cancelled` when the help is stopped. Its liveness is its help's heartbeat. Every lookup of a
task's latest run ignores kind `help`, as it ignores `title` and `rephrase`. A question help is
unchanged: it keeps the asking run, its worktree and its words.

`settleHelps` runs in the transaction of every task move and every insert of a spec version, with
the task row locked. A queued or running help whose subject no longer stands (the decision is no
longer offered, or the version, run, block or delivery run moved on) becomes `stopped` and its run
`cancelled`; a succeeded one gets `retired_at`. The usage already recorded stays in the task's
cost. `save_help_result` checks `stands` before the help's status: a stale save writes nothing and
answers "This decision is no longer offered; nothing was saved. End your turn now." The listing
(`GET /api/tasks/:id/helps`) returns for each decision and mode the latest help, and the latest
succeeded one while it is not retired and still stands.

The helper reads a decision with `get_decision` (the decision, mode, subject, task, and by
decision the spec and its lint; or the stopped run's block or failure, checkpoint, phase summaries,
latest Verify report, the actions offered now, `recommendable_actions` — Resume is left out when the
run left no checkpoint — and the plan a Re-run would keep; or what Mark done checks against, every
delivery run with its report and pull request). For a stopped run, `get_phase_record` reads the
run's latest non-help phase: the newest 300 entries in time order and `earlier_left_out`, the
number before them. A question help's `get_phase_record` still takes the first 300 events, as the
backlog says. `save_help_result` checks a result by mode and names the field to fix: `review` (a
verdict, findings that are empty exactly when nothing is to change, what it is unsure of; a
finding may carry `choices`, 2 to 5 strings of at most 200 characters each, none blank or equal
after trimming, with `recommended`, the index of one of them, given together: refused as too few,
too many, required, too long, duplicate, not allowed (`recommended` alone) or unknown choice; each
choice is stored trimmed with its whitespace runs turned into one space),
`restate` (what changes, what it requires, what it leaves out), `recommend` (why it stopped, an
action among the recommendable ones, reasoning, unsure) and `check` (what it checked against,
which must equal the source for the card's state, what the runs produced, the unfinished items,
unsure), and `code_review` (a verdict as in `review`; findings of at most 30, each a `kind` among
`bug`, `breaks`, `duplicate`, `fit` and `test`, a `file`, an optional `line` of at least 1, `text`
and `matters`; neither `choices` nor `recommended` is allowed on one). A saved review stores each finding as `{ kind, where, text, matters }`, `where`
being `file` or `file:line`, and the result carries `commit` and `skipped`, which the server
takes from the payload of the help run's `help_checkout` event: the commit or null, and the files
skipped by name (`{ path, skip }`) or none. The PR tab shows `skipped` as "Not reviewed", so the
helper never lists those files under `unsure`, whose 4,000 characters a large pull request's
lockfiles and generated files would otherwise fill. For a `pull_request` help `get_decision`
returns the run's number, branch and pull request, the approved spec, the run's accepted plan or
null, and its latest Verify report or null.

A decision help is claimed on the help lane (`POST /api/runner/helps/claim`) and shares its three
slots with question helps. The work carries the project's `repo_path` and `base_branch`, the
links, and a checkout source: `pr_branch` for Mark done in Review (the latest delivery run's
branch), `paused_run` for a Blocked stopped run, `base` otherwise. The runner writes `help.json`
(`repo_path`, `made_worktree`) in the help's run directory `~/.aidp/runs/<help run id>` before it
makes anything. `pr_branch` fetches the branch and makes a detached worktree of it, falling back
to `origin/<base>` when origin no longer has it; `paused_run` uses the paused run's own worktree
when it exists — copying its `linked.json`, making and removing nothing — and a detached
`origin/<base>` worktree when it does not; `base` makes that worktree. A worktree it makes comes
with linked checkouts under `~/.aidp/worktrees/<help run id>-linked/`, and no setup command runs.
A `help_checkout` event records the ref read, the source, whether it fell back and `commit`, the
full hash of HEAD in the worktree the helper reads (for a reused paused run's worktree, its HEAD,
without changes not committed there), and for a `pull_request` help `skipped`, each file marked
`skip` with its mark; the helper's first message carries a `<checkout ref source/>`
element and, when the help has linked checkouts, the same `<linked_projects>` element a phase
handoff carries (`linkedProjects` in `runner/src/phases/handoff.ts`) and the line "The linked
checkouts may be read and never changed." The source
`pull_request` fetches the run's branch and the base and makes a detached worktree of
`origin/<branch>`; it never falls back to the base, and fails the help with "the help's checkout
could not be made: the branch `<branch>` is not on origin" when the branch is gone. Before the
helper starts, the runner writes the whole of `git diff --no-renames origin/<base>...origin/<branch>`
to `pr.diff` in the help's run directory, uncut. Both that diff and the `--name-only` one that
names its sections run with `--no-color --no-ext-diff --no-textconv`, so the owner's git config
cannot colour, replace or convert the text. The first message carries
`<diff path bytes lines/>` and a `<changed_files>` element with one `<file path first_line lines/>`
per changed file, in the diff's order (`first_line` is the line of `pr.diff` where its section
begins); a lockfile or a generated file (`.min.js`, `.min.css`, `.map`) carries `skip="lockfile"` or
`skip="generated"`. The helper reads the diff section by section in parts of at most 1,000 lines,
skips marked files, which the board lists itself, and lists under `unsure` every file it read in
part or did not read, by directory and count when they are too many to name. A failed fetch or
worktree add fails the
help with "the help's checkout could not be made: …". The guard lets the helper read inside its
working directory and inside the linked checkouts of its `linked.json`, and Read and Grep exactly
the file `pr.diff` in its `BOARD_RUN_DIR`; every other path in the run directory stays refused, and
no other phase may read `pr.diff`.

When a decision help ends, whatever the outcome, the runner reads `help.json`: when it made the
worktree it removes the linked checkouts, the `-linked` directory and the worktree through
`guardPath` and prunes the registrations; when it did not, it removes no worktree and no
checkout, whatever `linked.json` lists. It then removes the run directory through its own guard,
`guardRunDir`, which passes exactly `~/.aidp/runs/<run id>` of the id it is given and nothing
else. Every removal is logged with caller `help`. At daemon start, before its first claim, the help
lane lists the run directories that hold a `help.json` and sends their ids to
`POST /api/runner/helps/ended`; the board answers the ids of help runs that have ended, and the
lane removes what the end of a help removes. When that call fails the lane logs it and goes on,
and the leftovers wait for a later start.

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
and a run resumed at the `tests` stage runs the gate again. It shares the three Build attempts;
a violation on attempt 3 ends the run `failed` with `the build changed files the run does not
allow, on attempt 3: <paths>` (the first 20 paths, then `and <n> more`). Each gate run sends a
runner `tool_call` event `files_gate`: `error` with `<n> paths the run does not allow` and the
`violations` (`path`, `reason`, `committed`) in its payload, or `ok` with `every changed path is
allowed`. The gate does not write `gate-head.txt`; the tests stage does, once (see below).

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
2. Runs `git fetch origin <base>` in the project's `repo_path`, then counts the new commits
   (`origin/<base>..HEAD`). With none, the runner undoes nothing and runs no setup, rebase or
   test command, and writes neither `gate-head.txt` nor `tested-base.txt`; it runs the files gate
   on the worktree as it stands (a violation sends Build round with `files_gate`, as always), and
   otherwise sends Build round with `no_commit`, the builder's uncommitted edits still in place.
   Known limit: when setup is owed and an earlier setup failed and left files behind, the gate
   can report those files as violations, since no undo runs on this path. Otherwise a rebase is
   owed when `origin/<base>` is not an ancestor of HEAD.
3. When setup is owed, undoes every uncommitted path; unless a rebase is owed, it then runs the
   setup command (a `setup_command` event), rewrites `excluded-paths.json` to the uncommitted list
   and writes `setup-base.txt`. A failed setup blocks the run as `step_failed` at `tests`.
4. Runs the files gate.
5. When a rebase is owed: undoes every uncommitted path, runs `git rebase origin/<base>`, and on
   success runs setup, rewrites `excluded-paths.json` and writes `setup-base.txt`.
6. Writes the worktree's HEAD to `gate-head.txt` (its only write), so the push stage compares
   against the rebased HEAD, and the fetched `origin/<base>` commit to `tested-base.txt`. Then the
   test command runs, and the runner acts on its result (below).

_The test command's result._ This applies to every project's test command. Every run of the
`tests` stage runs the test command, a Resume's included, whatever HEAD is. A run has one of four
results, decided in this order: timed out (`timedOut`), passed (`exitCode` 0), failed (any other
number, including one such as 137 from a child killed by a signal), and not run or killed
(`exitCode` null with `timedOut` false). The `test_command` event is sent first, whatever the
result. The same applies when the test command runs inside a Verify started afresh after a resume.

- Passed: the run goes on to Verify.
- Failed on attempt 1 or 2: no verifier starts. The runner writes `test-command-report.md` (the
  command, `exit code: <n>`, a line `[output cut to its end]` when the output was cut, the last
  20,000 characters of the output, and the instruction to make the command pass and commit,
  changing only the plan's files, and to say in the summary, changing nothing, when the failure is
  not in them), and Build goes round again with the failing report `test_command` in the
  checkpoint. `handoffFor('build')` reads the file, or a fixed text naming the test command when it
  is missing.
- Failed on attempt 3: the run is blocked, not ended, as `step_failed` at `tests`, with the attempt
  at 3. The block's command is the test command; its output is the first line below, the line
  `exit code: <n>`, the last 4,096 characters of the output, and the instruction.
- Timed out, or not run or killed, on any attempt: the run is blocked the same way with the attempt
  unchanged and no Build or Verify. The output is the matching first line below, the last 4,096
  characters of the output, the line on a cause outside the code below, and the instruction.
- A Build that changed nothing: when a Build ends ok on an attempt whose failing report is
  `test_command` and HEAD equals the commit in `gate-head.txt`, the runner does not run the test
  command again. The Build phase ends as succeeded and the run is blocked at `tests`, attempt
  unchanged, with the first line below and the instruction. This check is made when a Build ends,
  never by the `tests` stage.

The blocks' first lines, and the line on a cause outside the code that only a timeout or a
command that did not run adds before the instruction:

```
the test command failed on attempt 3
the test command was killed after its timeout
the test command did not run or was killed
the build changed nothing after the test command failed
If the cause was outside the code, for example the machine slept or the disk was full, Resume runs the command again as it is.
```

The instruction that ends each block reads: ``In <worktree>, make `<test command>` pass and
commit the fix, then Resume. A failure in a file outside the plan is fixed on the base branch
instead: push the fix to `origin/<base>`, then Resume, and the tests stage rebases the branch onto
it before the command runs. Only committed work is tested: Resume undoes uncommitted changes first,
and a path outside the plan committed in the worktree fails the files gate, which ends the run on
attempt 3.`` Resume runs the `tests` stage again from step 1.

In a Verify started afresh after a resume, a result other than passed acts the same way from the
`tests` stage: a fresh verify phase is dropped without a `phase_end`, a recorded phase whose
session is gone ends as not succeeded (`phase_end` `failed`) and is never restarted, and the
checkpoint then written names no verify phase.

A failure outside the plan's files costs one Build round, not two: the builder says so and changes
nothing, and the run blocks with `the build changed nothing after the test command failed`. A run
whose test command already fails on the base, or fails at random, and whose Builds keep
committing, uses up the three Build attempts and then blocks, or ends `failed` at the files gate
when a Build changed a path outside the plan.

Before every run of the test command, in this stage and in a Verify resumed with no test output,
the runner undoes the builder's uncommitted paths (those not in `excluded-paths.json`) and keeps
the excluded ones; it runs no setup and leaves `excluded-paths.json` as it is. Only committed work
is tested, verified and pushed. Known limits: a builder edit to a path already in
`excluded-paths.json` is not undone, and a file written under a gitignored path is not undone,
since the uncommitted list leaves ignored files out.

`undone-paths.json` in the run directory lists, sorted and once each, the builder's paths the
runner undid. The tests stage empties it at its top; the setup-owed and rebase-owed undos, the
base-conflict undo and the undo before the test command add to it. When it is not empty, the
Verify handoff's `<note>` says which paths were undone before the test command ran (after the
base-moved note, separated by a blank line), and the next Build's `<verify_report>` ends with a
paragraph naming them, whatever the failing report (never `no_commit`). A missing file reads as
empty.

`setup-base.txt` holds the merge-base of HEAD and `origin/<base>` as of the last setup that
succeeded: `prepare`, the Plan-stage refresh, a worktree remade on resume, and the tests stage
each write it after a successful setup, and a failed setup leaves it as it was. Setup is owed when
the project has a setup command and the file is missing or differs from that merge-base, so a
branch the builder or the owner rebased gets setup again, and a run started before the file
existed gets it once.

Each time the runner undoes uncommitted paths in this stage it first takes the ones not in
`excluded-paths.json`, which are the builder's; when there are any it sends a runner `tool_call`
event `undo_uncommitted` (status `ok`, target `undid <n> paths the build left uncommitted`,
payload `paths`).

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
`base_conflict` in the checkpoint, sharing the three Build attempts; `handoffFor('build')` reads the
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

**The start check.** Before it claims anything, the daemon checks that `CLAUDE_BIN` and `GH_BIN`
each name an executable. It accepts an absolute path to an existing regular file, symlinks
followed, that the daemon's user may execute, or a bare name (no `/`) that an absolute entry of
the runner's `PATH` holds as one; empty and relative `PATH` entries are skipped, a relative path
with a slash is refused, and the binary is never run. A refusal, like every configuration
error, is one `board-cli: ` line on stderr with no stack trace and exit status 1, before the
`claiming from` line: no handed-on claim is taken over and no request reaches the board. The
wrapper returns 1 on a first start and retries every `BOARD_CLI_RETRY_SECONDS` (10 s) after a
restart. A binary removed after start is not caught here: it is found at spawn and blocks the run
as `step_failed`, as above.

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
  check. When the code has moved it first waits for the title lane, as above, heartbeating the
  claimed run meanwhile and once more at the end, so the sweeper does not lose it. It then writes
  `<BOARD_HOME>/handoff.json` (one write to a temporary name, then a rename) holding the claimed
  work and the time the board last heard of the run: its last heartbeat that got through, or the
  claim if none did, which is what the sweeper counts from. It logs a
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

The Approvals tab, which a card waiting on a question opens on, holds the question and one form: its
options as the kit's `RadioGroup` named by the question — the recommended one's name ends
"(recommended)", an option's impact is its description — a field for an answer in words, and one
Send answer. Choosing sends nothing. While an option of a single request is chosen, a Clear choice
button after the group withdraws it, keeps the words and moves focus to the group's first radio. The
form explains an approval sent with words before sending anything, and a refusal on length says the
4,000-character limit. Send answer sends the option, the words or both; with neither it
marks the words field invalid and focuses it. Answering, Resume and Cancel move focus to the card's
state line before their controls go. A request's context is rendered Markdown, headings starting at
`h4` (`h5` for a batch question's); a plan's checks read as a table. A migration's stays plain code.
The header's count of waiting questions is text, not announced.

Each question carries the buttons Suggest an answer and Explain simply (busy while their help runs,
still focusable), and under them a section "Suggested answer" (option label, words, reasoning, what
the helper is unsure of, and **Use this answer**, which selects the option and fills the words and
sends nothing) and "In plain words". A result that arrives, or a help that fails with its reason, is
written into the card's status region as "Suggested answer ready for question 2 of 3", "Explanation
ready for the open question" or the failure, whichever tab is showing.

Decision helps add buttons. In Spec review the Spec tab's action row reads Edit, Approve, Review
spec, Explain simply, then the Redraft note field and Redraft; Approve and Redraft are enabled and
disabled as without help. The results sit in a section under an `h3` "Help with v<n>", after the
Lint section and before the tab's status region, each under an `h4` ("Spec review of v<n>": Nothing
to change or the findings, then Unsure about, then, when the verdict is changes and the Redraft
form is shown, the button Use these findings; "v<n> in plain words": What changes, What it
requires, What it leaves out), with a failure line "No spec review for v<n>: <reason>". Use these
findings puts one line per finding, `- <kind> (<where>): <text>` or `- <kind>: <text>` without a
where, into What to change: alone when the field is blank, else after the words already there and
a blank line. A second press adds the lines again. Unsure about stays out. When the Redraft form is
shown, each finding also holds a radio group "What to do with finding <n>": "Use as written"
(checked first), the finding's own choices in their saved order with " (recommended)" on the
helper's pick, then "Leave out"; no choice is checked by default. The picks are held in the page
only and reset to "Use as written" when a different review result is shown. A picked choice adds
the line `  Decision: <choice>` (the choice alone, without the mark) under its finding; a finding
with choices left "Use as written" adds `  Open choice, ask me: A (recommended); or B`, the
choices in order with "or" before the last; a finding left out adds nothing. Without the form a
finding with choices shows "Choices: A; B (recommended)" as text. It sends nothing and changes no
decision button; focus moves to the field with the caret at its end, any error on the field is
cleared, and "Findings put in What to change." is announced in the tab's status region on every
press, repeated ones included. When every finding is left out the note stays as it was, and
"Every finding is left out; What to change is unchanged." is announced instead. The card's action bar reads Move up, Move down, Mark done,
Check what is unfinished, Resume, Cancel run, Re-run with this plan, Re-run and plan again, Suggest
what to do, each where it is shown. Their results ("Suggested next step", "What is unfinished") sit
in one region after the status region and problem notice and before the Test command field, each
under an `h3`, with no control in them and no button that acts on a result. In Review a card with a pull request shows, on the PR tab right after the paragraph with the
pull request link, the button Review pull request, then its result before the Files changed
section, under an `h3` "Pull request review of <short commit>" (the commit's first 7 characters;
"Pull request review" when there is none): Nothing to change, or the findings, each with its kind
as a neutral badge, where and text, and "Why it matters:", then "Not reviewed:" with each skipped
file and its mark when the board skipped any, then Unsure about; a failure reads "No
pull request review: <reason>". The tab's focus order is the pull request link, Review pull
request, then what follows; the result holds no control, and a refused request uses the card's
problem notice through the tab's `onProblem`. The status region announces "Pull request review
ready for <short commit>." or "No pull request review: <reason>." on any tab. The review shows only
while the card is in Review. Every help button is
busy while its help runs and stays focusable, and focus stays on the button pressed. A refused or failed request shows the problem notice with
focus moved to it: "This card changed meanwhile; its latest state is shown." for a 409, else "That
did not work. Try again." The card's status region announces each decision help that ends,
whichever tab shows: "Spec review ready for v<n>.", "Plain-words spec ready for v<n>.", "Suggested
next step ready for the stopped run.", "Unfinished-work check ready for Mark done.", or the failure
sentence of its mode with the reason; a stopped help announces nothing. A result that goes away
with a move is covered by the state announcement; one that goes away with the state unchanged is
announced as "<its heading> no longer applies." The Timeline names a help run "Help <n>" and shows
its help's status in the run selector; it opens on the newest run that is not a help run.

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
card, an answer, a help and a batch by keyboard alone.
