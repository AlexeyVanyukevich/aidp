# Slice 3 — drafted specs

Status: **approved**, 2026-10-22; designed 2026-10-22. Builds on slices 1 and 2 as
[docs/architecture.md](../../architecture.md) describes them on that date.

> **This is a decision record, not a description of the system.**
>
> It states what was decided on 2026-10-22, before any of it was built. It is not revised as
> the code moves on.
>
> Read it to learn **why** something has the shape it does. For **what** the system does today,
> read [docs/architecture.md](../../architecture.md). Where the two disagree, the architecture
> document is right and this one is stale.

The [MVP design](2026-10-10-mvp-design.md) is this document's source: §13 names slice 3, and
§5, §6 and §8 hold most of what it builds. The [slice 2 design](2026-10-19-pause-and-resume-design.md)
built the approvals, pauses and resumes this slice reuses. This document records what the MVP
design left open, every place it departs from it, and what was measured before design began.
Anything the MVP design specifies for slice 3 and this one does not mention holds as written
there.

Throughout, as in the earlier designs: **the owner** is the board's one user; **the runner** is
the `board-cli daemon` process; **a target repository** is one the board carries tasks out in; a
**process** is one `claude -p` launch and a **session** the conversation one or more processes
carry. And:

- **a spec run** is a run of kind `spec`: one Spec phase that drafts a spec from the task's
  description and the target repository's code;
- **the spec-writer** is the agent of that phase;
- **a batch** is an approval of the new kind `questions`: several questions asked together,
  answered together;
- **the component kit** is the pair of packages the web app's widgets come from, `@zellige/core`
  (tokens and CSS) and `@zellige/react` (the components), each in its own repository.

---

## 1. Purpose

At the end of this slice, the owner writes a task's description, presses **Draft spec**, answers
the spec-writer's questions in one go, and finds a spec in Spec review that lints clean. A spec
that is not right goes back with **Redraft** and a note saying what to change. Writing a spec by
hand stays possible, as slice 1 built it.

The MVP's exit gate (MVP design §1) is measured after this slice.

## 2. Decisions taken while scoping

Taken with the owner on 2026-10-22.

| Question                                                   | Decision                                                                                                         | Why                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| How a spec run with several open questions asks them       | All at once: one approval holds them, and the owner answers them together                                        | One pause and one resume instead of one per question; the owner sees every question beside the others |
| Where a card goes when its spec run fails or is cancelled  | Back where it came from: Backlog after a first draft, Spec review after a redraft, with the reason on the card   | The owner can still write the spec by hand or draft again; Failed and Re-run are a delivery run's     |
| Whether the owner may save a spec by hand while one drafts | No: the editor is read-only in Spec draft. Cancel run stops the draft and returns the card, and the editor opens | No race between the agent's save and the owner's                                                      |
| How each question of a batch is answered in the web app    | A radio group per question, added to the component kit in its own repositories, then pinned here                 | The kit has no radio group; the project adds a missing widget to the kit, never to `web/`             |
| Which backlog entries the slice takes                      | "A builder that backgrounds a long command and ends its turn loses the work"                                     | The fix is in the guard and the phases' prompts, which this slice edits to add the spec-writer        |

The other entries in `docs/backlog.md` are left there knowingly. The usage-limit entry touches
`runner/src/phases/phase.ts`, which a spec run also goes through: a spec run refused at the limit
fails and returns its card, as §5 says, and the entry still stands for both kinds of run.

### Departures from the MVP design

| MVP design                                                               | This slice                                                                                                     | Reason                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| The spec-writer "raises an approval request for each open question" (§6) | It raises them in one batch, kind `questions`; after the answers it may raise another batch                    | §2                                                                                                                 |
| Spec draft → Spec review when the owner saves a spec by hand (§5)        | Not offered: the editor is read-only in Spec draft                                                             | §2                                                                                                                 |
| Spec draft → Failed when `claude` fails or the owner cancels (§5)        | Spec draft — or a spec run's Needs approval or Blocked — → Spec review if the task has a version, else Backlog | §2                                                                                                                 |
| Any later edit creates version n+1 (§4)                                  | Every save of one spec run rewrites that run's one version; a hand save still creates n+1                      | `save_spec` returns the lint so the agent fixes and saves again (§6); one version per draft keeps the picker short |
| Draft spec's guard: the description is not empty (§5)                    | Kept, and the card gains a description editor: the web app has none                                            | The add-task form takes a title only; without an editor the guard could never pass                                 |
| The header counts open approvals (slice 2 design, §11)                   | It counts the questions waiting: a batch of three counts three                                                 | "1 question waiting" would understate a batch                                                                      |
| Runs are numbered among all of a task's runs (slice 1)                   | Spec runs and delivery runs are numbered separately: "Draft 2", "Run 1", and the branch `board/<KEY>-r1`       | A task drafted twice would otherwise open its first pull request from `-r3`                                        |
| The guard's deny list (§6)                                               | Also denies `run_in_background: true` on `Bash` and `Agent`                                                    | §3; the backlog entry this slice takes                                                                             |

## 3. Measured before design

On 2026-10-21 and 2026-10-22, with Claude Code **2.1.287**, the version slice 2 recorded against,
signed in with a claude.ai subscription.

1. **`opus` resolves to `claude-opus-5-5`.** One process, "Reply with the single word ready.",
   with `--model opus --effort high --setting-sources project`: its `modelUsage` named
   `claude-opus-5-5` (4 output, 6,616 cache write, 19,692 cache read) and Claude Code's own
   Haiku call, `claude-haiku-4-5-20251001`. Claude Code reported $0.0579 in all. A spec-writer
   process therefore starts at about $0.06 before it reads any code.
2. **The board has no price row for `claude-opus-5-5`.** The local database holds rows for
   `claude-haiku-4-5-20251001` and `claude-sonnet-5-5` only, both from 2026-10-01. Until one is
   entered with `./run price:set`, a spec run's cost reads "or more: a model has no price yet".
   Prices are a fact about the outside world (MVP design §4): the row is entered from Anthropic's
   price list before the smoke run, and the tests use fixture prices.
3. **The backgrounded command was the model's request, not Claude Code's doing.** The slice 2
   smoke run's events hold the builder's three calls, one per attempt, each
   `{"command": "sleep 150", "run_in_background": true}`. Claude Code did not move a slow command
   into the background on its own; the model asked for it. A `PreToolUse` denial of that input
   is therefore enough to keep the work in the turn, with no need to watch for a background task
   at the end of a phase.

**Not measured:** how Opus fills the batch's nested input — questions holding options — and
whether it stops when the tool says the run is paused. Slice 2 saw Haiku and Sonnet stop
(slice 2 design §3, fact 5). The plan's first runner task records a spec run through the
stand-in board (§13), and the fixtures the tests use come from that recording.

## 4. Task lifecycle

The transition table (`server/src/modules/tasks/transitions.ts`) gains these moves, and three of
slice 2's widen to Spec draft:

| Move               | From → To                                                      | Actor                                           | Guard, in the service                                                         |
| ------------------ | -------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `draft_spec`       | Backlog → Spec draft                                           | Owner: **Draft spec**                           | The description is not empty. Queues a spec run                               |
| `redraft`          | Spec review → Spec draft                                       | Owner: **Redraft**, with a note                 | The note is not empty. Queues a spec run carrying the note                    |
| `finish_draft`     | Spec draft → Spec review                                       | Runner: the spec run ended                      | The run saved a version                                                       |
| `drop_draft`       | Spec draft, Needs approval or Blocked → Spec review or Backlog | Runner (the run failed), owner (**Cancel run**) | The run is a spec run. To Spec review if the task has a version, else Backlog |
| `request_approval` | Running **or Spec draft** → Needs approval                     | MCP `request_approval`                          | As slice 2                                                                    |
| `block`            | Running **or Spec draft** → Blocked                            | Sweeper or runner                               | As slice 2                                                                    |
| `answer`, `resume` | Needs approval or Blocked → Running **or Spec draft**          | Owner                                           | As slice 2; the destination is the run's kind                                 |

`cancel` stays a delivery run's move to Failed; Cancel run on a card whose run is a spec run makes
`drop_draft` instead. Everything else Cancel does is slice 2's: a running process is stopped, an
open or expired approval is withdrawn, and a paused or blocked run's worktree is cleaned up.
`rerun` stays Failed → Ready, which a spec run never reaches.

**The table stays the only place a move is decided, and stays pure.** Where a row's destination
depends on a fact — the run's kind, whether the task has a version — the caller passes that fact
and the table picks the state; nothing outside it writes `tasks.state`. A move the table refuses,
or a stale one, is `409 conflict` as before. An empty description or note is
`400 validation_error`, `details.field` `description_md` or `note`.

**Claiming a spec run** moves no card: the card is already in Spec draft when the run is queued.
A queued spec run whose card has left Spec draft — the owner cancelled it before the runner
claimed it — is skipped and cancelled, as a delivery start whose card left Ready is.

## 5. The spec run

### What the runner does

1. **Prepare.** A detached worktree at `origin/<base_branch>` under
   `~/.ai-task-board/worktrees/<run>`, and the run directory as for a delivery run. No branch, so
   nothing is pushed. Stages: `prepare`, then `spec`; checkpoints, pauses, blocks and resumes
   work as slice 2 built them, with `spec` a stage a session resumes from.
2. **Spec.** One phase, `spec`:

   | Agent       | Model, effort | Permission mode | Tools                                                                                           |
   | ----------- | ------------- | --------------- | ----------------------------------------------------------------------------------------------- |
   | spec-writer | `opus`, high  | default         | Read, Grep, Glob; board MCP `get_task`, `get_spec`, `save_spec`, `log_step`, `request_approval` |

   No edit tool, no `Bash`, no subagent, as the MVP design's §6 lists. The handoff carries the
   task's key, title and description; for a redraft, the version it redrafts and the owner's
   note. Its return format: "Call save_spec until the lint is clean, then reply with one
   paragraph."

3. **End.** The phase ends when its process ends by itself, as any phase does. Then:
   - **the run saved a version**: `run_end` with outcome `drafted`, the run `succeeded`, the card
     through `finish_draft`;
   - **it saved none**, or the phase failed: `run_end` `failed` with the reason — "the
     spec-writer saved no spec", or slice 1's "the spec phase failed" — and the card through
     `drop_draft`;
   - **cancelled**: `run_end` `cancelled`; the card has already moved.

   The worktree is removed in every case but a pause or a block.

A version that does not lint clean still moves the card to Spec review: the owner sees the lint
and fixes it by hand or redrafts. A version with open questions under `## Open questions` cannot
be approved, as before.

### The spec-writer's instructions

- Read the description and the code it touches before writing; keep the Spec tab's template:
  Goal, Context, Requirements as `R<n>`, Acceptance criteria as `AC<n> (R<n>)`, Out of scope,
  Constraints, Open questions.
- **Collect every question the description and the code leave open, and ask them together**, in
  one `request_approval` of kind `questions`: each with up to five options, the one recommended,
  and what the owner needs to choose. Do not guess an answer and do not leave a question in the
  spec for the owner to find. When the tool answers that the run is paused, end the turn; the
  answers arrive as the next message. A question the answers raise goes in a further batch.
- Save with `save_spec`; fix what its lint names and save again. Leave `## Open questions` empty.
- Finish with one paragraph saying what the spec covers and what it leaves out.

### The failure reason on the card

A card whose latest spec run failed shows, under its state line, "The last draft did not finish:
<reason>." until the next run starts. A cancelled draft shows nothing: the owner did it.

## 6. Batched questions

### The request

`request_approval` with `kind: "questions"` takes:

| Field              | Holds                                                                            | Limit              |
| ------------------ | -------------------------------------------------------------------------------- | ------------------ |
| `questions`        | 1 to 8 items, each `{ question, options?, recommendation?, context_md? }`        | as below           |
| — `question`       | The question                                                                     | 1,000 chars        |
| — `options`        | `{ id, label, impact? }`, ids unique within the question                         | 0 to 5; as slice 2 |
| — `recommendation` | One of the question's option ids                                                 | —                  |
| — `context_md`     | What the owner needs for this question                                           | 2,000 chars        |
| `question`         | Optional lead line; the server writes "<n> questions about the spec" when absent | 1,000 chars        |
| `context_md`       | Optional context shared by every question                                        | 8,000 chars        |

The server numbers the questions `q1` … `qn` in their order; the agent gives no ids. A batch is
refused, with the findings as the tool's error, as a single question is — `questions[2].question`
`required`, `questions[0].recommendation` `unknown_option` — and when the run already waits on an
approval. Every phase may ask a batch; only the spec-writer's instructions ask for one.

Accepted, a batch pauses the phase, the run and the card exactly as a single question does
(slice 2 design §5), and answers the agent with the same "Paused: … End your turn now."

### The answer

`POST /api/approvals/{id}/answer` with `{ answers: [{ question_id, option_id?, text? }] }` for a
batch; the slice 2 body, `{ option_id?, text? }`, for every other kind. A batch is answered
whole: **every question needs an option, words, or both.** Refused with `400 validation_error`:

- a question without an answer, `details.field` `answers[<i>]`, `i` being the question's index;
- an option the question lacks, `answers[<i>].option_id`;
- a question id the batch lacks, or one answered twice, `answers`;
- text over 4,000 characters, `answers[<i>].text`.

The rest is slice 2's answer: one transaction, the card through `answer`, the run queued with its
resume message. The message:

> The owner answered your questions:
>
> 1. <question>
>    <chosen label> — <its impact>
>    <the owner's words>
>
> 2. …

An expired batch stays answerable on the Blocked card, as an expired question does.

## 7. Specs and the MCP tools

**`save_spec`** (spec runs only — a delivery run's token is refused, as `get_spec`'s frozen spec is
a delivery run's) takes `body_md`, at most 50,000 characters. The run's first save inserts version
n+1 and supersedes earlier drafts, as a hand save does; each later save of the same run rewrites
that version's body. A save while the run's phase is not running is refused. It moves no card. It
answers with the lint, so the agent can act on it:

> Saved v3. Lint: clean.

or the version, each finding in the Spec tab's own words, and each open question.

**`get_spec`** in a spec run returns the task's latest version, the one a redraft starts from, or
"This task has no spec yet." In a delivery run it is unchanged.

**`get_task`** is unchanged.

## 8. Server surface

**REST**, added or changed:

| Method | Path                                 | Purpose                                                                       |
| ------ | ------------------------------------ | ----------------------------------------------------------------------------- |
| POST   | `/api/tasks/{id}/actions/draft-spec` | §4; no body                                                                   |
| POST   | `/api/tasks/{id}/actions/redraft`    | §4; `{ note }`, 1 to 4,000 characters, `additionalProperties: false`          |
| POST   | `/api/tasks/{id}/actions/cancel`     | Also from Spec draft; makes `drop_draft` for a spec run                       |
| POST   | `/api/approvals/{id}/answer`         | Also `{ answers }` for a batch (§6)                                           |
| GET    | `/api/approvals?status=open`         | Each approval with its number of questions: 1, or a batch's count             |
| POST   | `/api/runner/claim`                  | A spec run's `start` carries the version it redrafts and the note, or neither |

`PATCH /api/tasks/{id}` already takes `description_md`; it is refused with `409 conflict` outside
Backlog and Spec review, since a draft reads the description it started with.

The task's card view gains the latest spec run's failure reason (§5), and its open approval's
number of questions.

**Runner events.** `run_end` accepts the outcome `drafted`. A checkpoint's stage may be `spec`.

**MCP**: `save_spec` and `get_spec` as §7; `request_approval` accepts `kind: "questions"` (§6).

## 9. Data model

One migration, `003_drafted_specs`:

- `runs`: `spec_version` becomes nullable — a spec run's is the version it redrafts, null for a
  first draft; a check keeps it set on delivery runs. `note` text, a redraft's note. `number`,
  the run's number among the task's runs of its kind, set when the run is created, filled for
  existing rows by kind and creation order.
- `specs`: `run_id`, the spec run that wrote the version, null for a hand save.
- `approval_requests`: the kind `questions`; `questions` jsonb, the batch, null for other kinds;
  the answer's shape follows the kind.
- `phases`, `events`, `tasks`: no change.

## 10. The guard and the phases' instructions

From the backlog entry, settled by §3's third fact. The guard refuses `Bash` and `Agent` calls
whose input sets `run_in_background: true`, with:

> Run it in the foreground: a command or agent left running in the background is lost when your
> turn ends. Give a long command a timeout instead.

The builder's and verifier's instructions say the same before the guard has to; the line telling
agents to pass `run_in_background: false` to the explorer stays. The spec-writer has neither tool.

## 11. Web app

### The component kit's radio group

Added in the component kit's repositories before any web task needs it, following their own
conventions and suites:

- `@zellige/react`: `RadioGroup` — `label`, an optional `description`, `error`, `value`,
  `onChange` — and `Radio` — `value`, an optional `description`, its label as children — on React
  Aria's `useRadioGroup` and `useRadio`, which bring the keyboard model: Tab into and out of the
  group, arrow keys between its radios;
- `@zellige/core`: its CSS, on the kit's tokens, with a visible focus ring and an invalid state;
- released as new minor versions of both, which `web/package.json` then pins, in a `build(deps)`
  commit of its own.

### What changes on the card

- **The Spec tab** opens with the task's **Description**: a Field and Textarea, with the hint
  "What the task is for. The spec-writer drafts from it.", and **Save description**, editable in
  Backlog and Spec review.
- Below the spec editor: **Draft spec** on a Backlog card. On a Spec review card, a Field "What to
  change", hint "The spec-writer reads this with the current version.", and **Redraft**. Save as
  v<n> and Approve stay as they are.
- **In Spec draft** the editor is read-only and shows the latest version as the spec-writer saves
  it, with "The spec-writer is drafting. The editor opens again when it finishes."
- **The state line's actions** gain **Cancel run** on Spec draft cards, and on Needs approval and
  Blocked cards of a spec run, as on a delivery run's.
- **Under the state line**, a failed draft's reason (§5).
- **The Approvals tab** shows a batch as below; a single question, an out-of-plan request and the
  plan gate stay as slice 2 built them.
- **The Timeline** labels runs "Draft <n>" and "Run <n>", and the Spec phase as a band like the
  others. **The Cost tab** lists the Spec phase with the rest; its model is Opus.
- **The board's card** shows its phase, Spec, while drafting; **the header** counts questions (§2).

### A batch in the Approvals tab

Under an `h3`, "Open questions" — "Unanswered questions" once expired — the lead line and the
shared context. Then a form. Each question is a `section` headed by an `h4`, "Question <i> of
<n>", holding its context and:

- a **RadioGroup** named by the question's text, one Radio per option; the recommended one's name
  ends "(recommended)", an option's impact is its description. A question with no options has no
  group;
- a Field "Your answer to question <i>", a Textarea, with the hint "Optional when you choose an
  option." — or, with no options, "Write your answer."

One **Send answers** button ends the form. Choosing a radio sends nothing.

### Accessibility

As the MVP design's §8 and slice 2's §11, which stand; this is what slice 3 adds.

**Structure.** The Description and Redraft fields are labelled through the kit's Field. In a
batch, the tab's headings are `h3`, each question's `h4`; each radio group is the kit's, named by
its question.

**Focus order.** In the Spec tab: Description, Save description, the version picker, the spec,
Save as v<n>, Approve, then Draft spec — or What to change and Redraft. In a batch: question by
question, its radio group then its answer field, then Send answers, then the answered list.

- Draft spec, Redraft, Send answers and Cancel run on a spec run remove their own controls by
  changing the card's state: focus moves to the state line first, as for slice 2's buttons.
- A draft finishing while the card is open moves no focus; it announces (below).

**Names.** Every control's name is its visible text: Save description, Draft spec, Redraft, Send
answers; each radio by its option's label, "(recommended)" included; each answer field by its
label, which carries the question's number.

**States and announcements.** A busy button is `aria-busy`; an invalid group or field is the
kit's `aria-invalid`, described by its error. Into the card's status region:

- Save description: "Description saved.";
- a draft finishing: "<KEY>-<n> is now in Spec review. v<n> is ready to review.";
- a draft failing: "<KEY>-<n> is now in <state>. The last draft did not finish: <reason>.";
- a batch answered: "<KEY>-<n> answered. The run continues.", as slice 2's.

**Errors.**

- Draft spec on an empty description: "Write a description first; the spec-writer drafts from
  it." marks the Description field invalid and moves focus to it.
- Redraft with an empty note marks What to change invalid, "Say what to change.", and focuses it.
- Send answers with questions unanswered marks each one's answer field invalid, "Choose an option
  or write an answer.", and moves focus to the first such question's group, or its field when it
  has no options. What was chosen and typed stays.
- A stale answer or move (`409`), and any other failure, as slice 2's: the danger notice takes
  focus, and the choices stay.

**Not covered by the automated checks.** A screen reader, 200% zoom and a 320 px viewport, on a
batch of eight questions with five options each: tried by hand, or named as untried in the
slice's review.

## 12. Errors

| Failure                                                        | Result                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Draft spec on an empty description; Redraft on an empty note   | `400 validation_error`, `details.field` `description_md` or `note`; nothing changes |
| A description edited outside Backlog and Spec review           | `409 conflict`                                                                      |
| `save_spec` from a delivery run, or with no phase running      | The tool's error, with the reason; nothing is saved                                 |
| A batch that fails its limits                                  | The tool's error, with each finding; nothing changes                                |
| An answer leaving a question unanswered, or naming a wrong one | `400 validation_error`, `details.field` as §6                                       |
| The spec phase fails, or saves no spec                         | `run_end` `failed`; the card back to Spec review or Backlog, the reason on it       |
| A tool call with `run_in_background: true`                     | The guard refuses it, with §10's reason                                             |
| A queued spec run whose card left Spec draft                   | Skipped and cancelled at claim                                                      |

## 13. Testing

The kit's testing rule applies, as in the earlier slices.

- **Unit**: the transition table's new and widened rows, as a dataset over move, state, run kind
  and whether a version exists; a batch's request and answer rules, a row per finding; the batch's
  resume message; the guard's refusal of `run_in_background` on both tools and nothing else; the
  spec phase's handoff, first draft and redraft; `save_spec`'s lint reply; a run's number by
  kind; the stage a spec run's checkpoint resumes from.
- **Recordings.** `runner/scripts/record-stream.sh` gains a set, `specs`: the spec-writer's whole
  call against the stand-in board, which learns `save_spec` and batches — a process that asks a
  batch and pauses, its resume with the answers, and a save. The fake `claude`'s scenarios replay
  these, and the normalizer's tests read them, so Opus's usage is checked against what the CLI
  emits, not what it is assumed to.
- **Integration**: Draft spec → claim → a spec run's `start`; `save_spec` scoped to spec runs, and
  its rewrite of the run's one version; a batch → Needs approval → answered whole → `resume`
  claimed; an incomplete answer refused; a failed spec run returning its card to Backlog, and to
  Spec review after a redraft; Cancel from Spec draft, Needs approval and Blocked of a spec run;
  a queued spec run skipped after its card left; the description refused outside its two states;
  the migration over slice 2's data, numbering existing runs.
- **Runner against the fake `claude`**: a first draft that asks a batch, is answered, saves and
  reaches Spec review; a redraft through to Spec review; a spec-writer that saves nothing, its
  card back in Backlog; a spec run blocked by a stopped daemon and resumed; a builder whose
  backgrounded command the guard refuses, which then runs it in the foreground and commits.
- **The component kit**: the radio group's behaviour — keyboard, names, the invalid state — in
  the kit's own suites, in its repositories.
- **UI**: write a description, Draft spec, answer a batch by mouse, approve the spec, through to a
  pull request; the same batch answered by keyboard alone, asserting where focus lands; a
  redraft; axe-core on the Spec tab in Backlog, Spec draft and Spec review, and on a batch open,
  expired, partly answered and refused.
- **Smoke**, by hand, on the owner's subscription, after the price row for `claude-opus-5-5` is
  entered: one real task drafted from its description, its questions answered on the board,
  approved and carried to a pull request, with every phase's cost reconciled; and one redraft.

## 14. Documentation

The slice's last task updates `docs/architecture.md` — the lifecycle, the spec run, batches, the
guard's new refusal — and `README.md` where running changed: the price row for Opus, Draft spec
in the walkthrough. It deletes the backlog entry this slice fixes, in its fixing commit, and
archives the plan. The MVP design's status line then says all three slices are built, and the
exit gate's measurement begins.

## 15. Open questions and what stays unproven

- **Opus's batches are not yet recorded** (§3). If the recording shows it splitting questions
  over several calls, or not stopping when paused, the guard's refusal of every tool after a
  pause still bounds what it can do; the instructions are what would change.
- **The quality of a drafted spec** is judged by the owner, not by the tests: they prove the
  machinery, not that the spec-writer writes specs worth approving. The exit gate's ten tasks are
  where that shows.
- **A spec run's cost.** One Opus process costs about $0.06 before it does anything (§3), and a
  batch adds a second process. No budget applies to a spec run unless the task has `budget_usd`.
- **Eight questions** is a guess at the most a batch should hold; a spec-writer that needs more
  asks a second batch.

## 16. Out of scope

A spec-writer that edits the spec in place while the owner watches; drafting several tasks'
specs at once; questions answered partly and the rest later; spec templates per project; a
budget for spec runs other than `budget_usd`; the backlog's other entries (§2).
