# Slice 3 — drafted specs — Implementation Plan

> **For agentic workers:** carry this plan out task by task, in order. Steps use checkbox
> (`- [ ]`) syntax for tracking. Every task ends in one commit, or the two it names.

**Goal:** The owner writes a task's description and presses Draft spec. A spec-writer reads the
description and the code, asks its questions in one batch, and leaves a spec in Spec review.
Redraft sends it back with a note.

**Architecture:** The three workspaces, unchanged in shape. The server gains spec runs — queued
by two new actions, handed out by the claim, settled by `run_end` — a batch kind of approval,
and `save_spec`. The runner's stage machinery is shared between delivery and a new `drafting.ts`,
which carries out a spec run's one phase. The web app gains the description editor, Draft spec
and Redraft, and a batch form on the component kit's new radio group.

**Tech stack:** as slices 1 and 2 — see the archived plans' headers. Claude Code **2.1.287**.
`@zellige/core` and `@zellige/react` move to the versions Phase A releases.

**Spec:** [`docs/superpowers/specs/2026-10-22-drafted-specs-design.md`](../specs/2026-10-22-drafted-specs-design.md),
approved 2026-10-22. Read it first; this plan argues from it and does not restate its reasons.
Section numbers below (§n) are the spec's.

## Global constraints

The earlier slices' hold unchanged ([slice 1 plan](archive/2026-10-11-slice-1-task-to-pr.md),
"Global Constraints"; [slice 2 plan](archive/2026-10-20-slice-2-pause-and-resume.md)): the kit's
rules, `typebox` not `@sinclair/typebox`, `.js` imports in `server/` and `runner/`, none in
`web/`, no `any` outside migrations, the error shape, journeys by role and name with axe-core,
subject-only Conventional Commits, times injected and shortened by configuration. In addition:

- Branch: `feat/slice-3-drafted-specs`, already holding the spec. Merge by rebase onto `main`,
  then `git merge --ff-only`.
- `runner/src/contract.ts` and the server's schemas change in the **same commit** (CONTRIBUTING).
- **Real `claude` runs go through the owner's subscription.** Check `ANTHROPIC_API_KEY` is unset
  before any; never set one. Task 4 and Task 24 are the only tasks that run the real CLI.
- `./run check` passes at the end of every task. A task touching `web/` also runs
  `./run test:ui`.
- **Phase A happens in the component kit's repositories**, each in a session started at that
  repository's root, under that repository's own `CLAUDE.md` and conventions. This repository's
  tasks resume at Task 3 once both releases exist.

## Decisions this plan takes inside the spec

| Spec leaves open                                       | This plan                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How the table picks a destination from a fact (§4)     | `nextState(from, move, facts)` with `facts: { run: 'spec' \| 'delivery'; hasSpec: boolean }`. A row's `to` is a state, or a pure function of `facts`. `moveTask` takes the facts; `moveFacts(trx, taskId)` reads them in the same transaction. |
| Who decides whether a spec run saved a version (§5)    | The server. The runner ends a spec run whose phase succeeded with `run_end` outcome `drafted`; the effect finds a version with `specs.run_id` = the run, or turns the outcome into `failed`, "the spec-writer saved no spec".                  |
| How a batch is stored (§6, §9)                         | `approval_requests.questions`: `[{ id, question, options, recommendation, context_md }]`; the row's `options` is `[]`; its `answer` is `{ answers: [...] }`.                                                                                   |
| Where `save_spec`'s lint words live (§7)               | A pure `lintText(finding)` beside the parser in `server/src/modules/specs/spec-lint-text.ts`, worded as `web/src/card/lint.ts` words them. The web keeps its own copy: it owns its words.                                                      |
| How the runner shares stages between the two run kinds | Task 16 moves `carryOut`'s checkpoint, block, phase-step and end-phase closures into `runner/src/run-steps.ts`; `delivery.ts` and the new `drafting.ts` both build on it. A refactor with the suite unchanged.                                 |
| A spec run's worktree (§5)                             | `Git.prepareDetachedWorktree(repo, base, dir)`: `fetch origin <base>`, then `worktree add --detach <dir> origin/<base>`.                                                                                                                       |
| Which recording the fake `claude` replays for Opus     | It reads `--model`: `opus` replays `spec-1`, `spec-2` and `spec-plain` from Task 4; any other model, slice 2's `pause-1`, `pause-2` and `plain`.                                                                                               |
| How the fake runs a command through the guard          | A new step, `{ bash: string, background?: boolean }`, sent through `PreToolUse` as a `Bash` call with `run_in_background` when set, and run with `sh -c` only when allowed.                                                                    |
| The radio group's versions                             | `@zellige/core` 0.2.0 and `@zellige/react` 0.2.0, a minor release each: a new component and nothing changed.                                                                                                                                   |

## Backlog entries this slice takes

| Entry                                                                      | Task | Its commit deletes it |
| -------------------------------------------------------------------------- | ---- | --------------------- |
| A builder that backgrounds a long command and ends its turn loses the work | 10   | yes                   |

Left knowingly, as §2 says: the usage limit, `./run stop`, the sweeper's re-arm log, the
Approvals tab's manual checks, the kit's Field, cache-write prices, the platform design's
diagrams. The Approvals tab entry grows in Task 25 if the batch form is not tried by hand.

## File structure

```
(the component kit's repositories)
  @zellige/core: contract/radio.html, css/radio.css, zl.css      Task 1
  @zellige/react: src/radio.tsx, src/index.ts                    Task 2
server/src/
  db/migrations/003_drafted_specs.ts           new
  db/schema.ts, shared/vocabulary.ts           columns; `questions` kind; `spec` stage
  modules/tasks/transitions.ts, task.moves.ts  new moves; facts
  modules/tasks/task.actions.ts, task.routes.ts, task.schemas.ts, task.service.ts, task.repository.ts
  modules/specs/spec.service.ts, spec.repository.ts, spec-lint-text.ts (new)
  modules/approvals/approval-rules.ts, approval.service.ts, approval.schemas.ts
  modules/mcp/board-tools.ts                   save_spec, get_spec, batches
  modules/runner/runner.service.ts, event-effects.ts, runner.schemas.ts
  modules/runs/run.repository.ts               runs.number
runner/src/
  contract.ts                                  RunWork for spec runs; `spec` stage
  run-steps.ts                                 new: shared stage machinery
  delivery.ts                                  on run-steps
  drafting.ts                                  new: a spec run
  daemon.ts                                    dispatch by run kind
  git.ts                                       detached worktree
  hooks/guard.ts                               background refusal
  phases/agents.ts, phase.ts, handoff.ts       the spec phase
runner/scripts/record-stream.sh, board-stub.mjs, smoke.ts
runner/tests/fake/fake-claude.ts               opus fixtures, bash step
web/src/
  card/SpecTab.tsx, lint.ts, CardDrawer.tsx, blocks.ts, ApprovalsTab.tsx, approvals.ts,
  card/BatchForm.tsx (new), TimelineTab.tsx, timeline.ts
  board/questions.ts, QuestionsWaiting.tsx, api.ts, types.ts
tests/ui/drafting.spec.ts                      new; keyboard.spec.ts extended
docs/architecture.md, README.md, docs/backlog.md, the MVP and slice 3 specs' status lines
```

---

## Phase A — the component kit's radio group

Done in the kit's repositories, not here. Each is a slice there by that repository's own
documentation rule: its own spec and plan, written from §11 of this repository's spec, approved
by the owner, then built.

### Task 1: The radio group's markup and CSS, in `@zellige/core`

- [ ] In that repository, a spec and plan for a radio group: its contract file
      `contract/radio.html` with every state — unchecked, checked, focused, disabled, invalid,
      with and without a description, the group with and without its description and error —
      and `css/radio.css` on the kit's role tokens, a focus ring at least as visible as the
      Button's, imported by `zl.css`.
- [ ] Built to that plan, with that repository's suites passing.
- [ ] Released as `v0.2.0` on that repository's `chore: release 0.2.0` commit.

### Task 2: `RadioGroup` and `Radio`, in `@zellige/react`

- [ ] In that repository, a spec and plan for `RadioGroup` — `label`, `description?`, `error?`,
      `value`, `onChange`, `children` — and `Radio` — `value`, `description?`, `children` — on
      `useRadioGroup`, `useRadio` and `useRadioGroupState`, rendering Task 1's markup exactly,
      the native input visually hidden.
- [ ] Its tests, in that repository: the group is named by its label and described by its
      description and error; arrow keys move and select; Tab enters at the checked radio, or the
      first; `aria-invalid` follows `error`; a radio's description is its description.
- [ ] Peer dependency `@zellige/core` `~0.2.0`. Released as `v0.2.0`.

### Task 3: Pin the new kit here

**Files:** `web/package.json`, `package-lock.json`.

- [ ] `@zellige/core` → `github:AlexeyVanyukevich/zellige-core#v0.2.0`, `@zellige/react` →
      `github:AlexeyVanyukevich/zellige-react#v0.2.0`; `npm install`.
- [ ] Run `./run check` and `./run test:ui`: nothing the web app uses changed.
- [ ] Commit `build(deps): take the component kit's radio group`.

---

## Phase B — the recording

### Task 4: Record a spec-writer asking a batch and saving

Spends the owner's subscription, no money: Opus, about $0.06 a process before work (§3).

**Files:** `runner/scripts/board-stub.mjs`, `runner/scripts/record-stream.sh`, fixtures
`runner/tests/fixtures/stream/spec-{1,2,plain}.ndjson`.

- [ ] `board-stub.mjs`: `request_approval`'s input gains `kind` and `questions` (each
      `{ question, options?, recommendation?, context_md? }`, options `{ id, label, impact? }`),
      all optional so slice 2's recordings still match; `save_spec` with `body_md`, answering
      "Saved v1. Lint: clean.".
- [ ] `record-stream.sh` gains the set `specs`: a scratch repository holding one small
      TypeScript file (a `fetchJson` without retries) and a role, `spec-writer`, with §5's
      instructions in short, `Read`, `Grep`, `Glob` and both stub tools, on
      `--model opus --effort high` and the runner's other flags.
  - `spec-1` — "Draft a spec for: add retries to fetchJson." The description leaves the count,
    the backoff and which errors retry open on purpose. Expected: one `request_approval` with
    `kind: "questions"`, then the turn ends.
  - `spec-2` — resumed with answers to whatever it asked, in §6's resume-message format.
    Expected: `save_spec`, then a paragraph.
  - `spec-plain` — a description with nothing to ask ("rename fetchJson to getJson"). Expected:
    `save_spec` with no question.
- [ ] Run `ANTHROPIC_API_KEY= runner/scripts/record-stream.sh specs`. Check by eye: `spec-1`'s
      tool call holds a `questions` array, its result is `success`, it called nothing after the
      pause; `spec-2` and `spec-plain` each call `save_spec`; every result names
      `claude-opus-5-5`.
- [ ] **If `spec-1` asks question by question, or keeps working after the pause, stop**: it is
      §15's first open question coming true. Show the owner the recording before Phase C.
- [ ] Commit `test(runner): record a spec-writer asking a batch and saving`.

---

## Phase C — the schema and the pure cores

### Task 5: The schema for drafted specs

**Files:** `server/src/db/migrations/003_drafted_specs.ts` (new), `migrations/index.ts`,
`db/schema.ts`, `shared/vocabulary.ts`, `modules/specs/spec.service.ts` (`queueDeliveryRun` sets
`number`); test `server/tests/integration/migrations.test.ts`.

- [ ] **Test**, rows over a database migrated to 002 and seeded: two delivery runs and a spec
      run of one task get `number` 1, 2 and 1 by kind and creation order; a delivery run with
      `spec_version` null is refused by the check; a spec run with `spec_version` null is
      accepted; an approval of kind `questions` is accepted; `specs.run_id` is null on existing
      rows.
- [ ] Run; it fails: no migration 003.
- [ ] **Implement** §9: `runs.spec_version` drops `not null`, check
      `runs_delivery_has_spec` (`kind <> 'delivery' or spec_version is not null`); `runs.note`
      text; `runs.number` integer, backfilled with the row number partitioned by task and kind
      in creation order, then `not null`; `specs.run_id` uuid references `runs.id`;
      `approval_requests` kind check gains `questions`, column `questions` jsonb. `APPROVAL_KINDS`
      gains `questions`, `STAGES` gains `spec`. `queueDeliveryRun` sets `number` to the task's
      count of delivery runs plus one.
- [ ] Run `./run check`; commit `feat(db): add the columns drafted specs need`.

### Task 6: Number drafts and runs apart

**Files:** `server/src/modules/runs/run.repository.ts`, `modules/runner/runner.service.ts`;
tests `server/tests/integration/runs-read.test.ts`, `runner.test.ts`.

- [ ] **Test:** a task with a spec run then a delivery run lists them as numbers 1 and 1 with
      their kinds; the delivery run's claimed work has `number: 1`.
- [ ] Run; it fails with 2.
- [ ] **Implement:** both read `runs.number`; `RunView` (server and web types) carries `kind`.
- [ ] Run `./run check`; commit `feat(server): number a task's drafts and runs apart`.

### Task 7: The moves that draft and redraft

**Files:** `server/src/modules/tasks/transitions.ts`, `task.moves.ts`; test
`server/tests/unit/transitions.test.ts`.

- [ ] **Test**, the existing dataset extended to (from, move, facts, expected): every row of
      §4's table, including `answer` and `resume` landing in Spec draft for a spec run and in
      Running for a delivery run, `drop_draft` landing in Spec review with a version and in
      Backlog without one, `request_approval` and `block` from Spec draft, and `cancel` from
      Spec draft refused (a spec run's Cancel is `drop_draft`).
- [ ] Run; it fails.
- [ ] **Implement:** moves `draft_spec`, `redraft`, `finish_draft`, `drop_draft`; widened rows as
      §4; `nextState(from, move, facts)`; `moveTask(db, taskId, move, facts?)`, the facts
      defaulting to a delivery run with a spec, so every existing caller stays as it is;
      `moveFacts(trx, taskId)` reads the latest run's kind and whether a spec exists.
- [ ] Run `./run check`; commit `feat(server): add the moves that draft and redraft a spec`.

### Task 8: The rules of a batch

**Files:** `server/src/modules/approvals/approval-rules.ts`; test
`server/tests/unit/approval-rules.test.ts`.

- [ ] **Test**, datasets: `checkRequest` for kind `questions` — a row per §6 limit and finding,
      field paths `questions[<i>].question`, `questions[<i>].options`,
      `questions[<i>].recommendation`, `questions[<i>].context_md`, `questions` (none, or more
      than 8); `numberQuestions` gives `q1` … `qn`; the default lead line; `checkAnswer` for a
      batch — every §6 refusal with its field; `resumeMessage` for a batch, as §6 quotes it, with
      an option alone, words alone, both, and an option without impact; `questionCount` is 1 for
      every other kind.
- [ ] Run; it fails.
- [ ] **Implement:** `BatchQuestion`, `BatchAnswer`, the checks, the message and the count. The
      existing kinds' rows stay green.
- [ ] Run `./run check`; commit `feat(server): add the rules of a batch of questions and its answer`.

### Task 9: `save_spec`'s lint reply

**Files:** `server/src/modules/specs/spec-lint-text.ts` (new); test
`server/tests/unit/spec-lint-text.test.ts` (new).

- [ ] **Test**, a dataset: one row per `LintCode`, its words matching `web/src/card/lint.ts`'s;
      `lintReply(version, parsed)` for a clean spec ("Saved v3. Lint: clean."), one with
      findings, one with open questions, one with both.
- [ ] Run; it fails.
- [ ] **Implement.** The file imports nothing from `db/`.
- [ ] Run `./run check`; commit `feat(server): word the lint for the spec-writer`.

### Task 10: Refuse commands and agents sent to the background

**Files:** `runner/src/hooks/guard.ts`, `runner/src/phases/agents.ts`,
`runner/tests/fake/fake-claude.ts`, `docs/backlog.md`; tests `runner/tests/unit/guard.test.ts`,
`runner/tests/integration/scenarios.test.ts`.

- [ ] **Test, guard**, rows: `Bash` with `run_in_background: true` → denied with §10's reason;
      `Agent` with it → denied; either with `false` or without it → allowed; any other tool with
      the key → allowed.
- [ ] **Test, scenario**: a builder whose script runs `{ bash: "sleep 1", background: true }`
      sees the denial, then `{ bash: "sleep 1" }` runs, then it commits; the run reaches Review.
      The fake gains the `bash` step (see the decisions table).
- [ ] Run; both fail.
- [ ] **Implement:** the guard's rule before the deny list's command checks; the builder's and
      verifier's instructions gain "Run every command in the foreground and wait for it: a
      command left in the background is lost when your turn ends."
- [ ] Run `./run check`; commit `fix(runner): refuse commands and agents sent to the background`,
      deleting the backlog entry.

---

## Phase D — the server

### Task 11: Draft spec, Redraft, Cancel, and the description

**Files:** `server/src/modules/tasks/task.actions.ts`, `task.routes.ts`, `task.schemas.ts`,
`task.service.ts`, `modules/specs/spec.service.ts` (`queueSpecRun`); tests
`server/tests/integration/actions.test.ts`, `tasks.test.ts`.

- [ ] **Test**, actions: `draft-spec` on a Backlog card with a description → Spec draft, a
      queued spec run with `spec_version` null, `run.queued` published; with an empty
      description → `400`, `details.field` `description_md`; from Spec review → `409`.
      `redraft` with `{ note }` → Spec draft, the run's `spec_version` the latest version and its
      `note` the text; an empty note → `400` on `note`; an unknown field → `400`. `cancel` of a
      queued spec run → Backlog, run cancelled; of a paused spec run with a version → Spec
      review, approval withdrawn, cleanup queued.
- [ ] **Test**, tasks: `PATCH` with `description_md` in Backlog and Spec review → 200; in Spec
      draft, Ready and Running → `409`.
- [ ] Run; they fail.
- [ ] **Implement:** `ACTIONS` gains `draft-spec` and `redraft`; the route takes a body for
      `redraft` only (`{ note }`, 1 to 4,000, `additionalProperties: false`); `queueSpecRun`, given
      the base version and the note, numbers the run among spec runs; `cancel` reads the
      run's kind and makes `drop_draft` with `moveFacts` for a spec run, the rest of its work
      as today.
- [ ] Run `./run check`; commit `feat(server): draft and redraft a spec from the card`.

### Task 12: `save_spec` and `get_spec` for the spec-writer

**Files:** `server/src/modules/mcp/board-tools.ts`, `modules/specs/spec.repository.ts`; test
`server/tests/integration/mcp.test.ts`.

- [ ] **Test:** in a spec run with a running phase, a first `save_spec` inserts v(n+1) with
      `run_id`, supersedes the earlier draft, moves no card, and answers `lintReply`'s text; a
      second rewrites that version's body, no new version; from a delivery run's token →
      refused; with the phase paused → refused; over 50,000 characters → refused. `get_spec` in
      a spec run returns the latest version, or "This task has no spec yet."; in a delivery run,
      the frozen spec as today.
- [ ] Run; it fails.
- [ ] **Implement:** `SpecRepository.saveForRun(db, taskId, runId, body)`; the tool registered
      for every token, refusing by the run's kind — so the refusal is the tool's error, not a
      missing tool; `get_spec` by kind.
- [ ] Run `./run check`; commit `feat(mcp): let the spec-writer save and read the task's spec`.

### Task 13: Ask and answer a batch

**Files:** `server/src/modules/mcp/board-tools.ts`, `modules/approvals/approval.service.ts`,
`approval.schemas.ts`, `approval.routes.ts`; test `server/tests/integration/approvals.test.ts`.

- [ ] **Test:** `request_approval` with `kind: "questions"` and three questions → the row with
      `questions` numbered, the phase, run and card paused as a single question's are, the
      "Paused:" reply; with a finding → the tool's error naming the field. Answering it with
      every question → resume queued with §6's message; with one missing → `400`,
      `details.field` `answers[1]`; with `{ option_id }` → `400` on `answers`; a single question
      answered with `{ answers }` → `400`. `GET /api/approvals?status=open` gives the batch
      `question_count: 3`. An expired batch on a Blocked card is answerable.
- [ ] Run; it fails.
- [ ] **Implement:** the MCP input schema gains `kind: "questions"` and `questions`; `question`
      becomes optional for that kind; `openApproval` stores the batch; the answer body is a union
      of slice 2's and `{ answers }`, each `additionalProperties: false`, picked by the
      approval's kind; `ApprovalView` gains `questions` and `question_count`.
- [ ] Run `./run check`; commit `feat(server): ask and answer a batch of questions`.

### Task 14: Hand out spec runs, and settle the card when one ends

**Files:** `server/src/modules/runner/runner.service.ts`, `event-effects.ts`,
`runner.schemas.ts`, `modules/approvals/approval.service.ts`, `modules/tasks/task.actions.ts`,
`runner/src/contract.ts`; tests `server/tests/unit/event-effects.test.ts`,
`server/tests/integration/runner.test.ts`.

- [ ] **Test, unit:** `run_end` with `drafted` parses; a checkpoint with stage `spec` parses.
- [ ] **Test, integration:** claiming a queued spec run returns `start` with `kind: 'spec'`,
      `spec` null and `note` null for a first draft, the base version and note for a redraft,
      and leaves the card in Spec draft; a queued spec run whose card left Spec draft is skipped
      and cancelled. `run_end drafted` with a saved version → run succeeded, card Spec review;
      without one → run failed "the spec-writer saved no spec", card Backlog; `run_end failed`
      after a redraft → Spec review. A spec run's `request_approval`, answer and Resume move
      Spec draft ⇄ Needs approval and Blocked → Spec draft; a blocking `error` moves Spec draft
      → Blocked.
- [ ] Run; they fail.
- [ ] **Implement:** `RunWork.spec` nullable, `spec_version` nullable, `note`; the claim's
      Ready check becomes a Spec draft check for spec runs, with no `claim` move; `run_end`'s
      effect for a spec run as the decisions table says; every `moveTask` on a run's behalf —
      the answer, Resume, a block, the sweeper's — passes `moveFacts`. `runner/src/contract.ts`
      changes with them.
- [ ] Run `./run check`; commit `feat(server): hand out spec runs and settle the card when one ends`.

### Task 15: The card says why the last draft failed

**Files:** `server/src/modules/tasks/task.repository.ts`; test
`server/tests/integration/tasks.test.ts`.

- [ ] **Test:** a task whose latest run is a failed spec run has `draft_failure` its reason; a
      cancelled one, or a later run of either kind, gives `null`. A card waiting on a batch has
      `approval.questions: 3`.
- [ ] Run; it fails.
- [ ] **Implement** both fields on `TaskView`.
- [ ] Run `./run check`; commit `feat(server): say on the card why the last draft failed`.

---

## Phase E — the runner

### Task 16: Share a run's stage machinery

**Files:** `runner/src/run-steps.ts` (new), `runner/src/delivery.ts`.

- [ ] Move the checkpoint, block, shutdown check, phase step, end-phase and fail-phase helpers
      out of `carryOut` into a `RunSteps` built from the run, its directories and the deps;
      `State` and `stateOf` move with them, `stateOf` mapping a `spec` stage to a `spec` phase.
- [ ] No test changes: the unit, phase and scenario suites pass as they are.
- [ ] Run `./run check`; commit `refactor(runner): share a run's checkpoints, blocks and phase steps`.

### Task 17: The spec-writer, its handoff and its worktree

**Files:** `runner/src/phases/agents.ts`, `phase.ts`, `handoff.ts`, `runner/src/git.ts`; tests
`runner/tests/unit/agents.test.ts`, `handoff.test.ts`, `runner/tests/integration/git.test.ts`.

- [ ] **Test:** `PHASES.spec` is §5's row, its tools in both the agent and the allowed list; the
      spec-writer's instructions name `request_approval` kind `questions`, `save_spec`, and an
      empty Open questions, and carry the Spec tab's template word for word — Task 4's
      recording, told only the sections' names, wrote `**R1** …` and `**AC1 (R1, R8)** …`,
      which the parser reads as items without ids; and, in `spec-lint-text.test.ts`, a bolded id
      gets a finding naming the item, so the agent can fix it; the handoff for a first draft carries `<task phase="spec">`, the
      description and the return format, and for a redraft also `<spec version="n">` and
      `<note>`, all escaped; `prepareDetachedWorktree` leaves a worktree at `origin/<base>` with
      no branch and no new local branch in the repository.
- [ ] Run; they fail.
- [ ] **Implement:** the `spec` phase type through `PhaseInput` and `PhaseRecord`; `HandoffInput`
      with the spec fields optional and `description` and `note`; the git method.
- [ ] Run `./run check`; commit `feat(runner): add the spec-writer, its handoff and its worktree`.

### Task 18: Carry out a spec run

**Files:** `runner/src/drafting.ts` (new), `runner/src/daemon.ts`,
`runner/tests/fake/fake-claude.ts`; tests `runner/tests/unit/delivery.test.ts` (the stage a
checkpoint resumes from), `runner/tests/integration/scenarios.test.ts`.

- [ ] **Test**, scenarios with the fake on Opus's recordings:
  - a first draft whose spec-writer asks a batch of two, answered over the API, then saves: the
    card reaches Spec review with v1, the run `succeeded`, the worktree gone, the timeline
    holding the Spec phase with its pause;
  - a redraft: the handoff the fake logged holds the note and the version; the card reaches
    Spec review with v2;
  - a spec-writer that saves nothing: the card back in Backlog with `draft_failure` set;
  - the daemon stopped mid-phase: Blocked, then Resume with a new daemon, through to Spec
    review in the same phase row.
- [ ] Run; they fail: "spec runs arrive in slice 3".
- [ ] **Implement:** `draftSpec(work, deps)` on `RunSteps`: `prepare` (the detached worktree),
      `spec` (one phase, resumable), then `run_end` — `drafted` when the phase succeeded,
      `failed` with "the spec phase failed" otherwise, `cancelled` on a cancel — and the worktree
      removed unless released. The daemon dispatches `start` and `resume` by `run.kind`. The
      fake replays the Opus recordings for `--model opus`.
- [ ] Run `./run check`; commit `feat(runner): carry out a spec run, from draft to Spec review`.

---

## Phase F — the web app

### Task 19: Draft and redraft from the Spec tab

**Files:** `web/src/card/SpecTab.tsx`, `lint.ts`, `web/src/api.ts`, `types.ts`; tests
`web/tests/unit/lint.test.ts`, `api.test.ts`.

- [ ] **Test**, unit: the Spec tab's states as a dataset — which of Description, Save
      description, Draft spec, What to change and Redraft each task state offers, and when the
      editor is read-only; `api.action` sends `redraft`'s body.
- [ ] Run; it fails.
- [ ] **Implement** §11's Spec tab: the Description field and Save description ("Description
      saved." into the card's region); Draft spec on Backlog; What to change and Redraft on Spec
      review; the drafting notice and a read-only editor in Spec draft, the specs query
      refreshed on the card's `run.event`. Draft spec and Redraft move focus to the state line
      before they go. An empty description: the field invalid with §11's words, focused; an
      empty note likewise.
- [ ] Run `./run check` and `./run test:ui`; commit `feat(web): draft and redraft a spec from the Spec tab`.

### Task 20: A draft's progress and failure on the card

**Files:** `web/src/card/CardDrawer.tsx`, `blocks.ts`; test `web/tests/unit/blocks.test.ts`.

- [ ] **Test:** `actionsFor` offers Cancel run in Spec draft, and in Needs approval and Blocked
      whatever the run's kind; `blockText` words a `spec` stage "during the draft"; the state
      change's announcement for Spec draft → Spec review adds "v<n> is ready to review.", and for
      a failed draft adds "The last draft did not finish: <reason>."
- [ ] Run; it fails.
- [ ] **Implement:** the actions; the failure line under the state line from `draft_failure`;
      the announcements.
- [ ] Run `./run check` and `./run test:ui`; commit `feat(web): show a draft's progress and failure on the card`.

### Task 21: Answer a batch in the Approvals tab

**Files:** `web/src/card/BatchForm.tsx` (new), `ApprovalsTab.tsx`, `approvals.ts`; test
`web/tests/unit/approvals.test.ts`.

- [ ] **Test**, unit: `batchHeading` by status; a radio's name with "(recommended)"; each
      answer field's label and hint with and without options; `unanswered(questions, choices)`
      lists the indexes to mark; the answered list's line for a batch.
- [ ] Run; it fails.
- [ ] **Implement** §11's batch: the `h3`, lead and context; per question a `section` with its
      `h4`, the kit's `RadioGroup` named by the question, impacts as descriptions, and its answer
      field; Send answers. On send with gaps, each gap's field invalid and focus on the first
      gap's group or field; choices and text kept on any failure.
- [ ] Run `./run check` and `./run test:ui`; commit `feat(web): answer a batch of questions in the Approvals tab`.

### Task 22: Drafts on the timeline, and every question counted

**Files:** `web/src/card/TimelineTab.tsx`, `timeline.ts`, `web/src/board/questions.ts`,
`QuestionsWaiting.tsx`; tests `web/tests/unit/timeline.test.ts`, `questions.test.ts`.

- [ ] **Test:** a run's label is "Draft <n>" or "Run <n>" by kind; the header's total is the sum
      of `question_count`.
- [ ] Run; it fails.
- [ ] **Implement.** The Spec phase is a band like the others; the board's card shows Spec as its
      phase, which needs no change if the phase name is shown as it comes.
- [ ] Run `./run check` and `./run test:ui`; commit `feat(web): label drafts on the timeline and count every question waiting`.

### Task 23: The browser journeys

**Files:** `tests/ui/drafting.spec.ts` (new), `tests/ui/keyboard.spec.ts`, `tests/ui/helpers.ts`,
the UI fake's script.

- [ ] A journey: write a description, Draft spec, the card in Spec draft with a read-only
      editor, a batch of two answered by mouse, the card in Spec review with v1, Approve, through
      to the PR tab. axe-core at each state.
- [ ] A journey: Draft spec on an empty description, the field invalid and focused; Send answers
      with a gap, the gap's field invalid and its group focused; axe-core on both.
- [ ] A journey: Redraft with a note, through to v2.
- [ ] `keyboard.spec.ts`: the batch answered by keyboard alone — Tab between groups, arrows within
      one, Send answers — asserting focus on the state line afterwards.
- [ ] Run `./run test:ui`; commit `test(ui): draft a spec, answer its questions and redraft in the browser`.

---

## Phase G — the real thing, and the documents

### Task 24: The smoke run with a drafted spec

Spends the owner's subscription. Needs the price row first.

**Files:** `runner/scripts/smoke.ts`, `run`.

- [ ] Enter the price row for `claude-opus-5-5` from Anthropic's price list with
      `./run price:set` — with the owner, since the figures are theirs to confirm.
- [ ] `smoke.ts` gains `--draft`: it registers the scratch project, creates a task with a
      description that leaves two questions open, presses Draft spec, and prints the card's URL;
      the owner answers, reviews and approves on the board; the script waits for Review, then
      prints the pull request and every phase's cost beside Claude Code's.
- [ ] Run `./run smoke --draft`; then Redraft the same card once with a note, by hand. Keep
      what each showed — questions asked, versions, costs, drift — for the slice's review.
- [ ] Commit `test(runner): drive a drafted spec in the smoke run`.

### Task 25: The documents

**Files:** `docs/architecture.md`, `README.md`, `docs/backlog.md`,
`docs/superpowers/specs/2026-10-10-mvp-design.md`, `2026-10-22-drafted-specs-design.md`, this
plan.

- [ ] `docs/architecture.md`: a task's life with Spec draft; the spec run; batches; the guard's
      refusal; runs numbered by kind.
- [ ] `README.md`: Draft spec in the walkthrough; the Opus price row in setting up;
      `./run smoke --draft`.
- [ ] Try the batch form with a screen reader, at 200% zoom and at 320 px, eight questions of
      five options. What is not tried goes in the Approvals tab's backlog entry, by name.
- [ ] Status lines: this slice's spec **built**, with the date; the MVP design's "slices 1, 2
      and 3 built; the exit gate is being measured".
- [ ] Move this plan to `docs/superpowers/plans/archive/`, and commit both as
      `docs: describe the board as slice 3 built it`, as slice 2 did.
