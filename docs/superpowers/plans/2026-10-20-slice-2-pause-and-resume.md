# Slice 2 — pause and resume — Implementation Plan

> **For agentic workers:** carry this plan out task by task, in order. Steps use checkbox
> (`- [ ]`) syntax for tracking. Every task ends in one commit, or the two it names.

**Goal:** A run that cannot decide stops spending, asks on its card, and continues from the
owner's answer in the same Claude Code session. A run interrupted by anything else waits in
Blocked and continues on Resume.

**Architecture:** Slice 1's three workspaces, unchanged in shape. The server gains an
`approvals` module, a sweeper, new moves in the transition table and new effects for runner
events. The runner's delivery becomes a sequence of stages that can start from a checkpoint;
one phase is one Claude Code session, carried by one or more processes. The web app gains the
Approvals tab and the controls around it.

**Tech stack:** as slice 1 — see the archived plan's header. Claude Code **2.1.287**.

**Spec:** [`docs/superpowers/specs/2026-10-19-pause-and-resume-design.md`](../specs/2026-10-19-pause-and-resume-design.md),
approved 2026-10-20. Read it first; this plan argues from it and does not restate its reasons.
Section numbers below (§n) are the spec's.

## Global constraints

Slice 1's hold unchanged ([archived plan](archive/2026-10-11-slice-1-task-to-pr.md), "Global
Constraints"): the kit's rules, `typebox` not `@sinclair/typebox`, `.js` imports in `server/`
and `runner/`, none in `web/`, no `any` outside migrations, the error shape, journeys by role
and name with axe-core, subject-only Conventional Commits. In addition:

- Branch: `feat/slice-2-pause-and-resume`, already holding the spec and a backlog entry.
  Merge by rebase onto `main`, then `git merge --ff-only`.
- `runner/src/contract.ts` and the server's schemas change in the **same commit** (CONTRIBUTING).
- **Real `claude` runs go through the owner's subscription.** Check `ANTHROPIC_API_KEY` is
  unset before any; never set one. Task 4 and Task 27 are the only tasks that run the real CLI.
- Times that matter are injected: the server's `clock`, the sweeper's interval, the runner's
  pause grace, stop grace and marker poll. Tests shorten them by configuration, never by
  sleeping through the real values.
- `./run check` passes at the end of every task. A task touching `web/` also runs
  `./run test:ui`.

## Decisions this plan takes inside the spec

| Spec leaves open                                         | This plan                                                                                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How claim orders starts, resumes and cleanups (§6)       | `runs.queued_at`, set whenever work is queued — a start, an answer, a Resume, a cleanup — and cleared on claim. Claim takes the oldest `queued_at`.                                          |
| Where the plan gate's approval id comes from (§5)        | The runner generates it and sends it as `payload.approval_id`; it becomes `approval_requests.id`, so a replayed event opens nothing twice.                                                   |
| What the paused marker is (§6)                           | The file `<run dir>/paused`. The event hook writes it when a `PostToolUse` for `mcp__board__request_approval` carries a response whose text begins `Paused:`.                                |
| How the runner sees the marker (§6)                      | It checks for the file every `MARKER_POLL_MS` (500) while a process runs. `fs.watch` is not used: its behaviour differs across platforms.                                                    |
| Grace periods (§6)                                       | Runner config `PAUSE_GRACE_MS` (60 000) and `STOP_GRACE_MS` (10 000).                                                                                                                        |
| The sweeper's numbers (§8)                               | Server config `SWEEP_MS` (60 000). Constants, not configuration: lost after 90 000 ms without a heartbeat; an approval expires after 48 h.                                                   |
| Where a process's pid goes (§6)                          | `<run dir>/<phase>-<attempt>.pid`, removed when the process exits.                                                                                                                           |
| How the runner reports an interrupted phase (§7)         | `phase_end` carries `interrupted: true`; the sweeper sets `phases.interrupted` on the phase a lost runner held.                                                                              |
| How the runner keeps the baseline and reported cost (§7) | In the checkpoint: `session: { id, baseline, reported }`, `baseline` being the last result's `modelUsage` per model and `reported` the per-model `costUSD` contributed so far.               |
| What a blocked phase's status is (§8)                    | `paused`, like a paused one: Resume continues it.                                                                                                                                            |
| How the fake `claude` picks a script per task            | The script file maps a title fragment to a script, under `byTitle`, with the old top level as the default. The fake remembers each session's script in its state file, so a resume finds it. |

## Backlog entries this slice takes

| Entry                                                    | Task | Its commit deletes it |
| -------------------------------------------------------- | ---- | --------------------- |
| A PostgreSQL restart stops the server                    | 1    | yes                   |
| An unauthenticated runner request … answers 400, not 401 | 2    | yes                   |
| The PR tab's file list answers 500 …                     | 3    | yes                   |
| A runner that dies leaves its card in Running            | 14   | yes                   |

Left knowingly: "Cache writes are priced at one rate", "The kit's Field grows…", "The platform
design's two diagrams…", and "A run that reaches the subscription's usage limit…" — none touches
this slice's code paths beyond what §15 says.

## File structure

```
server/src/
  db/migrations/002_pause_and_resume.ts        new
  db/schema.ts, shared/vocabulary.ts           statuses, columns
  shared/bus.ts, db/client.ts                  reconnect; pool error listener
  modules/approvals/
    approval-rules.ts                          new, pure: payload checks, resume message, allowed files
    approval.schemas.ts                        new
    approval.service.ts                        new: open, answer, list
    approval.routes.ts                         new
  modules/tasks/transitions.ts                 new moves
  modules/tasks/task.actions.ts                resume; cancel widened
  modules/runner/event-effects.ts              new effects
  modules/runner/runner.{routes,schemas,service}.ts   claim kinds, heartbeat pause, preValidation
  modules/runs/sweep-rules.ts                  new, pure
  modules/runs/sweeper.ts                      new
  modules/runs/pr-files.ts                     { files: null }
  modules/costs/summarize.ts                   interrupted phases
  modules/mcp/board-tools.ts                   request_approval
runner/src/
  contract.ts                                  Work union, Checkpoint
  api.ts                                       timeouts, new calls
  stream/normalize.ts                          baseline, cut message, gone session
  hooks/guard.ts, hooks/hook-event.ts, cli.ts  paused marker, allowed files
  phases/claude-args.ts                        resume form
  phases/process.ts                            new: one process — pid, marker, stop
  phases/phase.ts                              a phase over one or more processes
  delivery.ts                                  stages from a checkpoint
  daemon.ts                                    work kinds, shutdown blocks
runner/scripts/record-stream.sh, board-stub.mjs, record-driver.ts   recordings
runner/tests/fake/fake-claude.ts               byTitle, --resume, MCP hooks
web/src/
  card/ApprovalsTab.tsx, card/approvals.ts     new
  card/CardDrawer.tsx, CostTab, PlanTab, PrTab, TimelineTab, timeline.ts
  board/TaskCardView.tsx, QuestionsWaiting.tsx (new), App.tsx, api.ts, types.ts, stream.ts
tests/ui/approval.spec.ts                      new; keyboard.spec.ts extended
docs/architecture.md, README.md, docs/backlog.md
```

---

## Phase A — the backlog fixes

These touch nothing else in the slice; doing them first keeps their commits small.

### Task 1: The server stays up when PostgreSQL restarts

**Files:** `server/src/shared/bus.ts`, `server/src/db/client.ts`, `server/src/modules/stream/stream.routes.ts`,
`web/src/stream.ts`; tests `server/tests/integration/bus.test.ts`,
`server/tests/integration/restart.test.ts` (new), `web/tests/unit/stream.test.ts`.

- [ ] **Test, bus:** in `bus.test.ts`, a row "reconnects and delivers again after its
      connection is terminated" — end the listening backend with `pg_terminate_backend`, found
      in `pg_stat_activity` by its `listen` query, then `publish` and expect delivery within
      5 s; and "tells its subscribers to resync after a reconnect": a subscriber receives
      `{ topic: 'resync' }`.
- [ ] **Test, restart** (`restart.test.ts`, its own container so the shared one is never
      stopped): build an app, `await container.restart()`, then `GET /api/health` answers 200,
      a claim with `wait_ms: 5000` returns when a run is queued afterwards, and the process is
      still alive (the test runs in-process: an unhandled `error` would fail it).
- [ ] Run both; they fail (the first with no delivery, the second with an unhandled error).
- [ ] **Implement, bus:** `BoardMessage` gains `{ topic: 'resync' }`. `start()` connects
      through a `connect()` that attaches `error` and `end` listeners; either schedules a
      reconnect with backoff 1 s doubling to 30 s, re-issues `listen board`, then notifies every
      subscriber with `{ topic: 'resync' }`. `stop()` sets a flag that suppresses reconnecting.
      Reconnect delays come from a constructor option so the test runs fast.
- [ ] **Implement, pool:** in `createDb`, `pool.on('error', …)` logs and swallows: pg already
      discards the broken client. `createDb` takes an optional logger; `server.ts` passes
      `app.log`'s methods after the app is built — create the pool with a no-op and set the
      listener from `server.ts`, or pass a logger factory; keep `createDb(url)` callable as
      today for tests.
- [ ] **Implement, stream:** `FORWARDED` gains `resync`. `web/src/stream.ts`: `keysFor` of
      `resync` is `[[]]` — every query — and `useBoardStream` listens for it. Unit row in
      `web/tests/unit/stream.test.ts`.
- [ ] Run `./run check`; commit `fix(server): keep the server up when PostgreSQL restarts`,
      deleting the backlog entry "A PostgreSQL restart stops the server".

### Task 2: Runner requests are authenticated before their body is read

**Files:** `server/src/modules/runner/runner.routes.ts`; test `server/tests/integration/runner.test.ts`.

- [ ] **Test:** a dataset — every runner route × { no `Authorization`, a wrong key, a wrong run
      token } × body `{}` — each answers `401` with `{ error: 'unauthorized' }`, identical
      bodies.
- [ ] Run; the claim and heartbeat rows fail with 400.
- [ ] **Implement:** `preHandler` → `preValidation` on every runner route; `runContext` is
      still set before the handler runs.
- [ ] Run `./run check`; commit `fix(server): authenticate runner requests before reading the body`,
      deleting the backlog entry.

### Task 3: An unlisted pull request's files are not an error

**Files:** `server/src/modules/runs/pr-files.ts`, `web/src/api.ts`, `web/src/types.ts`,
`web/src/card/PrTab.tsx`; test `server/tests/integration/pr-files.test.ts`.

- [ ] **Test:** rows — no PR → `{ files: [] }`; `gh` answers → `{ files: [...] }`; `gh` exits 1
      → `200 { files: null }` and one `warn` log line without `err.stack` (capture the logger
      with a test stream).
- [ ] Run; the third row fails with 500.
- [ ] **Implement:** return `{ files }`; on a failed `gh`, log one warning with the run's id
      and `gh`'s stderr, "GitHub did not list the pull request's files", and answer
      `{ files: null }`. Web: `prFiles` returns `{ files: PrFile[] | null }`; `PrTab` shows its existing sentence when `files` is
      `null` instead of on `isError` (keep the `isError` branch for a network failure).
- [ ] Run `./run check` and `./run test:ui`; commit
      `fix(server): answer an unlisted pull request's files without an error`, deleting the
      backlog entry.

---

## Phase B — the recordings

### Task 4: Record pauses, resumes and stopped processes

Spends the owner's subscription, no money: Sonnet and Haiku, a few cents at API prices in all.

**Files:** `runner/scripts/board-stub.mjs` (new), `runner/scripts/record-driver.ts` (new),
`runner/scripts/record-stream.sh`, fixtures under `runner/tests/fixtures/stream/`.

- [ ] `board-stub.mjs`: the stand-in board MCP server over stdio from the spec's probe —
      `request_approval` answering with §5's text ("Paused: the owner will answer on the
      board, …"), and `note` answering "Noted." It imports the SDK from the repository's `node_modules`.
- [ ] `record-driver.ts` (run with `tsx`): spawns `claude` with the arguments after `--`,
      writes stdout to a file, and sends `SIGTERM` or `SIGKILL` on a trigger — `init`, or
      `M:N`, N content deltas into message M. It sets `ANTHROPIC_API_KEY` to empty in the
      child's environment and refuses to run when the parent has one.
- [ ] `record-stream.sh`: keeps slice 1's two recordings and adds, all with Sonnet and the
      runner's whole set of flags (an `agents.json` with one role whose prompt asks it to end
      every reply with a fixed word, both stub tools allowed, hooks absent):
  - `pause-1.ndjson`, `pause-2.ndjson` — asks, stops; resumed with the answer;
  - `term-1.ndjson`, `term-2.ndjson` — three notes then a story, `SIGTERM` at `2:30`; resumed;
  - `kill-1.ndjson`, `kill-2.ndjson` — the same with `SIGKILL`;
  - `gone-1.ndjson`, `gone-2.ndjson` — `SIGKILL` at `init`; the resume, which fails;
  - `chain-1.ndjson`, `chain-2.ndjson`, `chain-3.ndjson` — a pause, a resume killed at `2:30`,
    a second resume;
  - `gone.stderr` — the second process's stderr in the `gone` pair.

  The script prints each file's line count and, from each final result, the models it saw.

- [ ] Run `ANTHROPIC_API_KEY= runner/scripts/record-stream.sh`. Check by eye that `pause-1`
      ends with a `success` result, `kill-1` has no result, `gone-2` is an
      `error_during_execution` result, and `gone.stderr` starts `No conversation found`.
- [ ] Commit `test(runner): record pauses, resumes and stopped processes`.

---

## Phase C — the schema and the pure cores

### Task 5: The schema for pauses and blocks

**Files:** `server/src/db/migrations/002_pause_and_resume.ts` (new), `migrations/index.ts`,
`db/schema.ts`, `shared/vocabulary.ts`; test `server/tests/integration/migrations.test.ts`.

- [ ] **Test:** rows — a run with status `paused` and one with `blocked` insert; `phases.status`
      `paused` inserts; `approval_requests.status` `withdrawn` inserts; `runs.pending` refuses
      `'other'`; `down` then `up` leaves the same columns.
- [ ] Run; fails.
- [ ] **Implement** `002_pause_and_resume`, repeating its vocabularies as 001 does:

```ts
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table runs drop constraint runs_status_known`.execute(db)
  await sql`alter table runs add constraint runs_status_known check (status in
    ('queued', 'running', 'paused', 'blocked', 'succeeded', 'failed', 'cancelled'))`.execute(db)
  await db.schema
    .alterTable('runs')
    .addColumn('checkpoint', 'jsonb')
    .addColumn('block', 'jsonb')
    .addColumn('pending', 'text')
    .addColumn('resume_message', 'text')
    .addColumn('queued_at', 'timestamptz')
    .execute()
  await sql`alter table runs add constraint runs_pending_known
    check (pending is null or pending in ('resume', 'cleanup'))`.execute(db)
  await sql`update runs set queued_at = created_at where status = 'queued'`.execute(db)
  await db.schema
    .createIndex('runs_queue')
    .on('runs')
    .column('queued_at')
    .where(sql.ref('queued_at'), 'is not', null)
    .execute()

  await sql`alter table phases drop constraint phases_status_known`.execute(db)
  await sql`alter table phases add constraint phases_status_known
    check (status in ('running', 'paused', 'succeeded', 'failed'))`.execute(db)
  await db.schema
    .alterTable('phases')
    .addColumn('interrupted', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute()

  await sql`alter table approval_requests drop constraint approvals_status_known`.execute(db)
  await sql`alter table approval_requests add constraint approvals_status_known
    check (status in ('open', 'answered', 'expired', 'withdrawn'))`.execute(db)
  await db.schema.alterTable('approval_requests').addColumn('files', 'jsonb').execute()
  await db.schema
    .createIndex('approvals_by_status')
    .on('approval_requests')
    .columns(['status', 'created_at'])
    .execute()
}
```

      `down` reverses each step. `vocabulary.ts`: `RUN_STATUSES` gains `paused` and `blocked`
      (delete the comment that promised them); `PHASE_STATUSES`, `APPROVAL_STATUSES`,
      `APPROVAL_KINDS` (`question`, `out_of_plan`, `plan`), `BLOCK_CAUSES` (`runner_lost`,
      `step_failed`, `runner_stopped`, `approval_expired`), `STAGES` (`prepare`, `plan`,
      `build`, `tests`, `verify`, `push`, `pr`). `schema.ts` follows; `checkpoint` and `block`
      are `JSONColumnType` of the `Checkpoint` and `Block` types, declared in `vocabulary.ts`:

```ts
export interface SessionTotals {
  input: number
  output: number
  cache_read: number
  cache_write: number
  usd: number
}
export interface Checkpoint {
  stage: Stage
  attempt: number
  phase_id: string | null
  session: {
    id: string
    baseline: Record<string, SessionTotals>
    reported: Record<string, number>
  } | null
  head: string | null
  plan_artifact_id: string | null
  failing_report_id: string | null
}
export interface Block {
  cause: BlockCause
  stage: Stage | null
  command?: string
  output?: string
}
```

- [ ] Run `./run check`; commit `feat(db): add the columns pauses, blocks and resumes need`.

### Task 6: The new moves

**Files:** `server/src/modules/tasks/transitions.ts`; test `server/tests/unit/transitions.test.ts`.

- [ ] **Test:** add rows to the existing dataset, every (state, move) pair the table now names
      and a refusal for each move from each state it does not list:
      `request_approval` running→needs_approval; `answer` needs_approval→running and
      blocked→running; `expire` needs_approval→blocked; `block` running→blocked; `resume`
      blocked→running; `cancel` from ready, running, needs_approval, blocked → failed.
- [ ] Run; the new rows fail.
- [ ] **Implement:** add the moves to `MOVES` and `TABLE`; widen `cancel`'s `from`.
- [ ] Run `./run check`; commit `feat(server): add the moves that pause, block and resume a task`.

### Task 7: The rules of an approval

**Files:** `server/src/modules/approvals/approval-rules.ts` (new); test
`server/tests/unit/approval-rules.test.ts` (new).

A pure module, no `db/` import.

- [ ] **Test, `checkRequest(input)`** — a dataset of `request_approval` inputs → `[]` or the
      findings: a `question` with 0 to 5 options is fine; 6 options, an empty question, a
      question of 1 001 characters, a label of 201, an impact of 501, a context of 8 001, a
      recommendation naming no option, two options sharing an id, `out_of_plan` without files,
      with 21 files, with an absolute path, with `..` — each one finding with its field.
- [ ] **Test, `optionsFor(kind, agentOptions)`:** `question` keeps the agent's; `out_of_plan`
      is `[{ id: 'allow', label: 'Allow the change' }, { id: 'refuse', label: 'Keep to the plan' }]`;
      `plan` is `[{ id: 'approve', label: 'Approve plan' }]`.
- [ ] **Test, `resumeMessage(approval, answer)`** — rows per kind and answer shape:

| Kind          | Answer                     | Message                                                                                       |
| ------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| `question`    | option `b` (label, impact) | `The owner answered your question:\n\n5 retries, then dead-letter queue — New DLQ table`      |
| `question`    | option and text            | the option line, a blank line, then the text                                                  |
| `question`    | text only                  | `The owner answered your question:\n\n<text>`                                                 |
| `out_of_plan` | `allow`                    | ``The owner allowed changes to: `src/a.ts`, `src/b.ts`.``                                     |
| `out_of_plan` | `refuse` and text          | ``The owner kept to the plan. Do not change: `src/a.ts`.\n\n<text>``                          |
| `plan`        | text                       | `The owner asked for changes to the plan:\n\n<text>\n\nSave the revised plan with save_plan.` |
| `plan`        | `approve`                  | `null` — approving starts Build, it resumes no session                                        |

- [ ] **Test, `allowedFiles(planFiles, answered)`:** the plan's files plus every `allow`ed
      `out_of_plan` approval's files, deduplicated, in first-seen order; a `refuse`d one adds
      nothing.
- [ ] **Test, `checkAnswer(approval, answer)`:** neither field → finding on `text`; an unknown
      `option_id` → finding on `option_id`; text over 4 000 → `text`.
- [ ] Run; all fail (no module).
- [ ] **Implement** the five functions.
- [ ] Run `./run check`; commit `feat(server): add the rules of an approval request and its answer`.

### Task 8: The sweeper's decisions

**Files:** `server/src/modules/runs/sweep-rules.ts` (new); test `server/tests/unit/sweep-rules.test.ts` (new).

- [ ] **Test, `sweepDecisions({ now, lastTick, intervalMs, runs, approvals })`** → `{ rearm }`
      or `{ lost: runId[], expired: approvalId[] }`. Rows, with `intervalMs` 60 000:

| Row                          | lastTick     | Input                                | Result                     |
| ---------------------------- | ------------ | ------------------------------------ | -------------------------- |
| first tick                   | `null`       | a run silent 5 min                   | `rearm`                    |
| normal tick, run silent 89 s | now − 60 s   | `running`, last heartbeat now − 89 s | lost: none                 |
| normal tick, run silent 91 s | now − 60 s   | `running`, now − 91 s                | lost: that run             |
| paused run silent for hours  | now − 60 s   | `paused`, now − 5 h                  | lost: none                 |
| after a sleep                | now − 10 min | `running`, now − 10 min              | `rearm`                    |
| just under the gap           | now − 119 s  | `running`, now − 3 min               | lost: that run             |
| approval at 47 h 59 m        | now − 60 s   | open, created now − 47 h 59 m        | expired: none              |
| approval at 48 h             | now − 60 s   | open, created now − 48 h             | expired: that one          |
| approval after a sleep       | now − 10 min | open, created now − 49 h             | `rearm` — expiry waits too |

- [ ] Run; fails.
- [ ] **Implement:** a gap longer than `2 × intervalMs` since `lastTick`, or no `lastTick`,
      re-arms and decides nothing.
- [ ] Run `./run check`; commit `feat(server): decide which runs are lost and which approvals expire`.

### Task 9: The effects of the new runner events

**Files:** `server/src/modules/runner/event-effects.ts`; test `server/tests/unit/event-effects.test.ts`.

- [ ] **Test:** extend the dataset — each new event shape → its `Effect`, or the
      `ValidationError` it raises:
  - `checkpoint` with a payload matching `Checkpoint` → `{ kind: 'checkpoint', checkpoint }`;
    an unknown stage, an attempt below 1, a non-object session → refused.
  - `error` with `payload.blocks: true`, `cause: 'step_failed'`, `stage: 'push'`, `command`,
    `output` → `{ kind: 'block', block }`; `cause: 'runner_stopped'` without command → fine;
    `cause: 'runner_lost'` or `'approval_expired'` from a runner → refused (the server's own);
    `blocks` absent → `undefined`, as slice 1.
  - `phase_start` with `payload.resumed: true` → `{ kind: 'phase_resume', phaseId, sessionId }`.
  - `phase_end` with `payload.interrupted: true` → its effect carries `interrupted: true`;
    absent → `false`.
  - `approval_requested` from the runner with `approval_id`, `kind: 'plan'`, `question`,
    `context_md` → `{ kind: 'plan_approval', … }`; any other kind from the runner → refused
    (agents ask through MCP).
  - `run_end` `outcome: 'cancelled'` from a cleanup → as slice 1.
- [ ] Run; fails.
- [ ] **Implement** the parsing; `Effect` gains the four kinds.
- [ ] Run `./run check`; commit `feat(server): read checkpoints, blocks and resumes from runner events`.

---

## Phase D — the server

### Task 10: Approvals — open, answer, list

**Files:** `server/src/modules/approvals/approval.{schemas,service,routes}.ts` (new),
`server/src/app.ts`, `server/src/shared/bus.ts`, `server/src/modules/stream/stream.routes.ts`;
test `server/tests/integration/approvals.test.ts` (new), `server/tests/integration/fixtures.ts`.

- [ ] **Fixture:** `fixtures.ts` gains `runningRun()` — a project, a task in Running, a run
      `running` with a phase `running` — and `pausedRun(kind)` built on it through the service.
- [ ] **Test, open:** `ApprovalService.open(trx, request)` — `request` carrying `runId`,
      `taskId`, `phaseId`, `kind`, `question`, `options`, `recommendation`, `context_md`,
      `files` and an optional `id` — in a transaction: the approval row;
      an `approval_requested` event on the phase; phase `paused`; run `paused`; task
      `needs_approval`; one `task.updated` and one `approval.requested` notice after commit.
      A second open on the same run → `ConflictError`. An `id` already present → no-op
      (replay).
- [ ] **Test, answer** — `POST /api/approvals/:id/answer`, a dataset:

| Approval state                  | Body                       | Result                                                                                                                                                                                               |
| ------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| open `question`                 | `{ option_id: 'b' }`       | 200; answered; task `running`; run `queued`, `pending: 'resume'`, `queued_at` set, `resume_message` per Task 7; `approval_answered` event; notices `task.updated`, `approval.answered`, `run.queued` |
| open `question`                 | `{ text: 'Use 3' }`        | 200, as above                                                                                                                                                                                        |
| open `question`                 | `{}`                       | 400, `details.field: 'text'`                                                                                                                                                                         |
| open `question`                 | `{ option_id: 'zz' }`      | 400, `details.field: 'option_id'`                                                                                                                                                                    |
| open                            | `{ text: 'x', extra: 1 }`  | 400 (schema)                                                                                                                                                                                         |
| answered                        | `{ text: 'again' }`        | 409                                                                                                                                                                                                  |
| withdrawn                       | `{ text: 'x' }`            | 409                                                                                                                                                                                                  |
| expired, task blocked by it     | `{ option_id: 'a' }`       | 200; task `running`                                                                                                                                                                                  |
| expired, task no longer blocked | `{ option_id: 'a' }`       | 409                                                                                                                                                                                                  |
| open `plan`                     | `{ option_id: 'approve' }` | 200; `resume_message` null; `pending: 'resume'`                                                                                                                                                      |

- [ ] **Test, lists:** `GET /api/tasks/:id/approvals` newest first with `options`, `answer`,
      `files`; `GET /api/approvals?status=open` across two projects, each with `task_key`,
      `project_key`, oldest first; `status` other than `open` → 400.
- [ ] Run; fails.
- [ ] **Implement:** schemas (`AnswerBody` `{ option_id?: string(≤50), text?: string(≤4000) }`,
      `additionalProperties: false`); the service using `approval-rules.ts` and `moveTask`; the
      routes; `BoardMessage` gains `approval.requested` and `approval.answered` with `taskId`;
      the stream forwards them. `queueDeliveryRun` (`specs/spec.service.ts`) now sets
      `queued_at`.
- [ ] Run `./run check`; commit `feat(server): open, answer and list approval requests`.

### Task 11: The MCP tool `request_approval`

**Files:** `server/src/modules/mcp/board-tools.ts`; test `server/tests/integration/mcp.test.ts`.

- [ ] **Test:** through the MCP client as slice 1's tests do: a valid `question` → the reply
      text of §5, exactly, and the state Task 10 asserts; findings from `checkRequest`
      → `isError` with them listed; no running phase → `isError` "No phase of this run is
      running"; an open approval already → `isError` "This run is already waiting for an
      answer. End your turn now."; `out_of_plan` → options are the server's, not the agent's.
- [ ] Run; fails.
- [ ] **Implement:** register the tool with a zod schema mirroring Task 7's limits; call
      `ApprovalService.open` in a transaction; reply.
- [ ] Run `./run check`; commit `feat(mcp): let an agent ask the owner and pause its run`.

### Task 12: The runner's endpoints — resume, cleanup, pause, and the new effects

**Files:** `server/src/modules/runner/runner.{service,schemas,routes}.ts`, `runner/src/contract.ts`;
test `server/tests/integration/runner.test.ts`.

- [ ] **Test, claim** — a dataset of queue states → the work returned:
  - a queued start on a Ready task → `{ kind: 'start', run }` and the task `running`,
    `queued_at` cleared;
  - a resume (`pending: 'resume'`) → work of kind `resume` with the run, its checkpoint, the
    message and the allowed files; task stays `running`; run `running`, `pending` and `queued_at` cleared,
    `runner_id` and `last_heartbeat_at` set;
  - a cleanup → `{ kind: 'cleanup', run: { id, repo_path, worktree_path } }`; `pending`
    cleared;
  - three of them queued in turn → returned oldest `queued_at` first;
  - an answer while a claim waits (`wait_ms: 5000`) → the claim returns the resume within a
    second (`NOTIFY`);
  - a queued start whose task left Ready → cancelled and skipped, as slice 1.
- [ ] **Test, heartbeat:** `{ cancel, pause }` — a run of this runner that is `paused` → in
      `pause`; `cancel_requested` → in `cancel`; `blocked` or `cancelled`, or now another
      runner's → in `cancel`.
- [ ] **Test, ingest effects** (events through `POST /api/runner/events`):
  - `checkpoint` → `runs.checkpoint` replaced;
  - a blocking `error` → run `blocked`, `block` stored, task through `block`, the running phase
    `paused`; on a task no longer Running → stored, nothing moves;
  - `phase_start` `resumed` → phase back to `running`, session id updated when it differs;
  - `phase_end` `interrupted` → `phases.interrupted`;
  - runner `approval_requested` `plan` → `ApprovalService.open` with its id; replayed → once.
- [ ] Run; fails.
- [ ] **Implement:** `tryClaim` takes the run with the oldest non-null `queued_at`,
      `for update skip locked`, then branches on `pending` and status. `Work` becomes the union
      in both `runner.service.ts` and `runner/src/contract.ts`:

```ts
export type Work =
  | { kind: 'start'; run: RunWork }
  | {
      kind: 'resume'
      run: RunWork
      checkpoint: Checkpoint
      message: string | null
      allowed_files: string[]
    }
  | { kind: 'cleanup'; run: { id: string; repo_path: string; worktree_path: string | null } }
```

      `allowed_files` comes from `allowedFiles` over the run's plan artifact and its answered
      `out_of_plan` approvals. `Checkpoint` and the effects' payload types are copied into
      `contract.ts` in this commit.

- [ ] Run `./run check`; commit `feat(server): hand the runner resumes and cleanups, and record its checkpoints`.

### Task 13: Resume and the wider Cancel

**Files:** `server/src/modules/tasks/task.actions.ts`, `task.routes.ts`, `task.service.ts`,
`task.repository.ts`, `runs/run.repository.ts`; tests `server/tests/integration/actions.test.ts`,
`tasks.test.ts`.

- [ ] **Test, resume:** blocked by `runner_lost`, `step_failed`, `runner_stopped` → task
      `running`, run `queued` with `pending: 'resume'`, `queued_at` set, and the resume
      message "You were interrupted. Continue from where you stopped."; blocked by
      `approval_expired` → 409; not blocked → 409; no checkpoint → 409.
- [ ] **Test, cancel:** from Needs approval → task `failed`, run `cancelled`,
      `pending: 'cleanup'`, `queued_at` set, approval `withdrawn`; from Blocked → the same, no approval
      touched when none is open; from Running and Ready → as slice 1.
- [ ] **Test, read models:** `GET /api/tasks/:id` gains `approval: { id, kind, status } | null`
      (the open or expired one) and `block: Block | null`; the board's cards gain
      `question_waiting: boolean`; `GET /api/tasks/:id/runs` phases gain `interrupted`.
- [ ] Run; fails.
- [ ] **Implement:** `ACTIONS` gains `resume`; `performAction` per the tests.
- [ ] Run `./run check`; commit `feat(server): resume a blocked task and cancel a paused one`.

### Task 14: The sweeper

**Files:** `server/src/modules/runs/sweeper.ts` (new), `server/src/server.ts`, `server/src/config.ts`;
test `server/tests/integration/sweeper.test.ts` (new).

- [ ] **Test**, with an injected clock: a `running` run silent 91 s → `blocked`, its block's
      cause `runner_lost`, task `blocked`, its running phase `paused` and `interrupted`, one
      `task.updated`; an approval open 48 h → `expired`, run `blocked` with `approval_expired`,
      task `blocked`; the first tick decides nothing; a tick after a 10-minute gap decides
      nothing and the next one does.
- [ ] Run; fails.
- [ ] **Implement:** `Sweeper` like `PrPoller`: `tick()` loads candidates, calls
      `sweepDecisions`, applies each in its own transaction through `moveTask` (`block`,
      `expire`); `start(intervalMs)`. Config `SWEEP_MS` (60 000). Wire it in `server.ts`.
- [ ] Run `./run check`; commit `feat(server): block the runs of a lost runner and expire unanswered approvals`,
      deleting the backlog entry "A runner that dies leaves its card in Running".

### Task 15: Interrupted phases in the cost summary

**Files:** `server/src/modules/costs/summarize.ts`, `cost.service.ts`; test
`server/tests/unit/summarize.test.ts`.

- [ ] **Test:** rows — an interrupted phase 50% off → `drift: null`, `flagged: false`,
      `interrupted: true`; the same phase not interrupted → flagged as slice 1; an event whose
      payload has `cut: true` → its phase line gains `cut: true`.
- [ ] Run; fails. **Implement**; the service passes `interrupted` and the cut flag through.
- [ ] Run `./run check`; commit `feat(server): leave interrupted phases out of the cost comparison`.

---

## Phase E — the runner

### Task 16: The normalizer across processes

**Files:** `runner/src/stream/normalize.ts`; test `runner/tests/unit/normalize-sequences.test.ts` (new).

- [ ] **Test** — one dataset row per Task 4 recording sequence, each a list of fixture files
      run through one normalizer per process, carrying the baseline from each result to the
      next, as the runner will:

| Row     | Files                 | Expect                                                                                                            |
| ------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| pause   | `pause-1`, `pause-2`  | the events' sum per model equals `pause-2`'s `modelUsage`, every counter; reported cost equals its `costUSD`      |
| term    | `term-1`, `term-2`    | Claude Code's own calls (models with no stream message) summed equal `term-2`'s figure for them; nothing negative |
| kill    | `kill-1`, `kill-2`    | `kill-1` ends with one `cut: true` event, its output the `message_start` count; the same check as `term`          |
| chain   | `chain-1`, `-2`, `-3` | as `kill`, across three processes                                                                                 |
| gone    | `gone-1`, `gone-2`    | `gone-2`'s normalizer reports `sessionGone: true`; no events                                                      |
| slice 1 | `plain`, `subagent`   | unchanged from slice 1: one process, baseline zero                                                                |

- [ ] Run; fails.
- [ ] **Implement:** the constructor takes `baseline: Record<string, SessionTotals>` (default
      empty). `message_start` remembers its usage; a process that ends with one open emits it
      from `finish()` with `cut: true`. `finish()` subtracts the baseline as §7 says, never
      below zero. `reportedCost()` returns `costUSD − baseline.usd` per model, never below
      zero. `sessionGone` is true for an `error_during_execution` result of zero turns.
      `totals()` returns the result's `modelUsage` as the next baseline.
- [ ] Run `./run check`; commit `feat(runner): count a session's usage once across its processes`.

### Task 17: The paused marker and the guard

**Files:** `runner/src/hooks/guard.ts`, `runner/src/hooks/hook-event.ts`, `runner/src/cli.ts`;
tests `runner/tests/unit/guard.test.ts`, `hook-event.test.ts`, `runner/tests/integration/cli-hooks.test.ts`.

- [ ] **Test, guard** — new rows: `paused: true` refuses `Read`, `Bash`, `Edit` and
      `mcp__board__log_step` with `The run is paused; end your turn.`; the out-of-plan reason is
      §5's exact text; a file in `allowedFiles` but not the plan is allowed.
- [ ] **Test, hook:** `pausedBy(input)` is true for `PostToolUse` of
      `mcp__board__request_approval` whose `tool_response` is one text block beginning
      "Paused:"; false for an error response, another tool, a different text.
- [ ] **Test, CLI** (`cli-hooks.test.ts`): `board-cli event PostToolUse` with that input
      creates `<run dir>/paused`; `board-cli guard` then answers a deny for `Read`.
- [ ] Run; fails.
- [ ] **Implement:** `decide` takes `paused: boolean` and `allowedFiles: string[] | null` (read
      from `allowed-files.json`, which replaces `plan-files.json`); the CLI's `event` writes the
      marker; `guard` checks it first.
- [ ] Run `./run check`; commit `feat(runner): stop every tool once the run is paused`.

### Task 18: The board client — timeouts and the new calls

**Files:** `runner/src/api.ts`, `runner/src/config.ts`; test `runner/tests/unit/api.test.ts` (new).

- [ ] **Test** with an injected `fetch` that never resolves: `claim(…, 1000)` rejects after
      `1000 + 10 000` ms of a fake timer; `heartbeat` after 30 000; the rejection is retryable
      by the sink's rule. `heartbeat` returns `{ cancel, pause }`. Config rows: `PAUSE_GRACE_MS`,
      `STOP_GRACE_MS`, `MARKER_POLL_MS` with defaults 60 000, 10 000, 500.
- [ ] Run; fails. **Implement** with `AbortSignal.timeout`.
- [ ] Run `./run check`; commit `fix(runner): give up on a board request that never answers`.

### Task 19: One process — resume arguments, pid, marker, stopping

**Files:** `runner/src/phases/claude-args.ts`, `runner/src/phases/process.ts` (new),
`runner/src/phases/phase.ts`; tests `runner/tests/unit/claude-args.test.ts`,
`runner/tests/integration/phase.test.ts`.

- [ ] **Test, args:** a `resume` input yields `-p <message> --resume <session>` and every other
      flag of the start form, without `--session-id`.
- [ ] **Test, process** against small shell stand-ins: a pid file exists while it runs and is
      gone after; a stand-in that creates `<run dir>/paused` and sleeps is sent `SIGTERM` after
      the pause grace (shortened to 200 ms) and reported stopped `paused` and interrupted;
      one that exits on its own after creating the marker → stopped `paused`, not
      interrupted; an abort signal → `SIGTERM`, and `SIGKILL` after the stop grace
      for a stand-in that traps `TERM`; a leftover pid file naming a live process is killed
      before the new process starts.
- [ ] Run; fails.
- [ ] **Implement** `runProcess(input, deps)`, returning the exit code, how it was stopped
      (`no`, `paused`, `cancelled` or `shutdown`), whether it was interrupted, and its
      normalizer. `phase.ts` keeps `phase_start`,
      the token and the closing events, now over a list of processes: `startPhase`,
      `continuePhase` (sends `phase_start` with `resumed: true`), `endPhase` (sends
      `phase_end` with the summed reported cost and `interrupted`).
- [ ] Run `./run check`; commit `feat(runner): run one process of a phase, stoppable and resumable`.

### Task 20: Delivery as stages from a checkpoint

**Files:** `runner/src/delivery.ts`, `runner/src/daemon.ts`, `runner/src/git.ts`; tests
`runner/tests/unit/delivery.test.ts`.

- [ ] **Test** with injected `runPhase`, `git`, `runTests` and a recording sink — a dataset
      of (work, scripted outcomes) → (events sent, outcome):
  - a start that pauses in Build → checkpoints `prepare`, `plan`, `build`; no `phase_end` for
    Build; no `run_end`; the worktree kept; outcome `released`;
  - a resume at `build` with a message → `continuePhase` with the message, then tests, Verify,
    push, PR, `run_end` review;
  - the plan gate: confidence `medium` → an `approval_requested` with kind `plan` and a fresh
    id, outcome `released`; a resume at `plan` with a null message (approved) → `phase_end`
    for Plan, then Build attempt 1; with a message → `continuePhase` of the planner;
  - `git push` failing → a blocking `error` with `step_failed`, stage `push`, the command and
    output; outcome `released`; a resume at `push` → push again; at `pr` with a PR already
    open (`gh pr view --head` answers) → no second `gh pr create`;
  - the daemon's stop signal during Verify → the process stopped, a blocking `error` with
    `runner_stopped`, outcome `released`;
  - a resume whose worktree is missing → `run_end` failed, "the run's worktree is gone";
  - a resume whose session is gone and whose phase holds no message → the phase started again
    with a new session id, same phase id; one that holds messages → `run_end` failed with
    §6's reason;
  - a cleanup → `removeWorktree`, `run_end` cancelled.
- [ ] Run; fails.
- [ ] **Implement:** `carryOut(work, deps)` walks `STAGES` from the checkpoint's stage (from
      `prepare` for a start), sending a `checkpoint` as each begins and after each process;
      the stage functions are slice 1's code moved into them. `Git` gains `head(dir)` and
      `findPr(dir, githubRepo, branch)`. The daemon handles the three work kinds, passes a
      shutdown signal (SIGINT/SIGTERM) down, and on `released` returns to claiming.
- [ ] Run `./run check`; commit `feat(runner): carry a run out in stages it can stop and resume`.

### Task 21: The fake `claude` pauses, and the scenarios

**Files:** `runner/tests/fake/fake-claude.ts`, `runner/tests/integration/scenarios.test.ts`.

- [ ] **Fake:** reads the script by title (`byTitle`, else the top level), remembering
      `sessionId → script` in its state file; on `--resume`, finds the session's script and
      plays the agent's next call; runs `PreToolUse` and `PostToolUse` hooks around every
      `tool` step with `tool_name: mcp__board__<tool>` and the MCP reply as `tool_response`;
      replays `pause-1.ndjson` after a step that paused and exits, `pause-2.ndjson` on a
      resume, `plain.ndjson` otherwise; a `{ stubborn: true }` step keeps calling `log_step`
      every 100 ms after a pause.
- [ ] **Scenarios**, each through the real server, the daemon and the fake:
  - a question in Build → Needs approval → answered through the API → Review, with one Build
    phase row and the answer in the builder's resumed call;
  - the plan gate: approved → Build; answered with changes → the planner resumed, a second
    plan saved, then approved;
  - an out-of-plan edit → refused, asked, allowed → the file in the branch;
  - a push failing once (a fake remote that rejects the first push) → Blocked with the command
    → Resume → Review;
  - the daemon killed mid-Build (`HEARTBEAT_MS` 200, the sweeper ticked by hand) → Blocked
    `runner_lost` → Resume with a new daemon → Review;
  - the daemon stopped with `SIGTERM` mid-Verify → Blocked `runner_stopped` → Resume → Review;
  - a stubborn fake → its `log_step` calls refused after the pause, the process ended after the
    shortened grace, the phase interrupted;
  - Cancel from Needs approval → the cleanup removes the worktree.
- [ ] Run `./run check`; commit `test(runner): pause, block and resume runs end to end`.

---

## Phase F — the web app

Each task here runs `./run test:ui` before its commit.

### Task 22: The Approvals tab

**Files:** `web/src/types.ts`, `web/src/api.ts`, `web/src/stream.ts`, `web/src/card/approvals.ts`
(new), `web/src/card/ApprovalsTab.tsx` (new), `web/src/card/card.css`; tests
`web/tests/unit/approvals.test.ts` (new), `stream.test.ts`.

- [ ] **Test, pure helpers** (`approvals.ts`): `optionName(option, recommendation)` → the label,
      plus ` (recommended)` on the recommended one; `answerSummary(approval)` → the text the
      answered list shows per kind and answer shape; `headingFor(status)` → `Open question` or
      `Unanswered question`; `keysFor` of the approval topics → `['approvals', taskId]`,
      `['approvals', 'open']`, `['task', taskId]`, `['board']`.
- [ ] Run; fails.
- [ ] **Implement** the types, `api.approvals(taskId)`, `api.openApprovals()`,
      `api.answer(id, body)`, the helpers, and `ApprovalsTab` as §11 specifies: an `h3`; the
      question; the context, rendered as the Plan tab renders Markdown; the files list; a
      `role="group"` with `aria-labelledby` the question's id, holding one kit `Button` per
      option with its impact as `aria-describedby` text beneath; a kit `Field` "Your answer"
      (or "Changes to ask for") with a `Textarea` and the hint; **Send answer**; the answered
      list; the kit's `Empty`. Answering calls a prop `onAnswered` (Task 23 moves focus there)
      and `onProblem`. An empty Send answer marks the field invalid and focuses it.
- [ ] Run `./run check` and `./run test:ui`; commit `feat(web): answer an approval request on the card`.

### Task 23: The card's controls around a pause

**Files:** `web/src/card/CardDrawer.tsx`, `web/src/card/blocks.ts` (new); test `web/tests/unit/blocks.test.ts` (new).

- [ ] **Test:** `blockText(block)` → §8's sentences per cause, the stage named for
      `runner_stopped`; `actionsFor(state, block)` → which of Mark done, Resume, Cancel run,
      Re-run show, a row per state and block cause; `initialTab(task)` → `approvals` for Needs
      approval and for an expired approval's block, else `spec`.
- [ ] Run; fails.
- [ ] **Implement:** the Approvals tab fourth; the initial tab; Resume and the widened Cancel
      through `actionsFor`, each moving focus to the state line first; the block's sentence
      under the state line, a failed step's output in a `<details>` "Command output"; the
      announcements of §11 — answering, a question arriving while open (after the state
      change's), Resume; the danger notice's two texts.
- [ ] Run `./run check` and `./run test:ui`; commit `feat(web): resume and cancel paused cards, and say why one is blocked`.

### Task 24: Questions on the board and in the header

**Files:** `web/src/board/TaskCardView.tsx`, `web/src/QuestionsWaiting.tsx` (new), `web/src/App.tsx`.

- [ ] **Test:** rows for `questionsText(n)` → nothing at 0, "1 question waiting" at 1,
      "3 questions waiting" at 3.
- [ ] **Implement:** the card's `Question waiting` badge when `question_waiting`; the header's
      text from `api.openApprovals()`, not a live region.
- [ ] Run `./run check` and `./run test:ui`; commit `feat(web): show waiting questions on the board and in the header`.

### Task 25: Timeline, Plan and Cost for pauses

**Files:** `web/src/card/timeline.ts`, `TimelineTab.tsx`, `PlanTab.tsx`, `CostTab.tsx`; test
`web/tests/unit/timeline.test.ts`.

- [ ] **Test, timeline model:** `approval_requested` and `approval_answered` events become
      markers in their phase's band; the time between a phase's last event before a pause and
      its `phase_start` `resumed` becomes a `{ kind: 'paused', ms }` entry; a band with none is
      as slice 1.
- [ ] Run; fails.
- [ ] **Implement:** the markers as list items with text — "Asked: <question>", "Answered" —
      and "Paused for <duration>"; the Plan tab's line while a `plan` approval is open; the Cost
      tab's "Not compared: …" for an interrupted phase and "at least" beside a cut phase's
      counters.
- [ ] Run `./run check` and `./run test:ui`; commit `feat(web): show pauses on the timeline and interrupted phases in costs`.

---

## Phase G — the whole product, and closing the slice

### Task 26: The journeys

**Files:** `tests/ui/global-setup.ts`, `tests/ui/approval.spec.ts` (new), `tests/ui/keyboard.spec.ts`.

- [ ] **Setup:** the script gains `byTitle` entries — `Ask about colours` (the builder asks a
      `question` with options red and blue, blue recommended), `Stop after the plan` (a
      `medium`-confidence plan), `Push fails once`; the fake remote for the last.
- [ ] **Journey, by mouse:** a task titled "Ask about colours" → approve its spec → the card
      reaches Needs approval and opens on Approvals → scan → press "blue (recommended)" → the
      status region reads "PAY-n answered. The run continues." → the card reaches Review →
      the Answered list shows the answer → scan. The header read "1 question waiting" while it
      waited. "Stop after the plan" → Send answer empty → the field invalid and focused → scan →
      press Approve plan → Review.
- [ ] **Journey, Blocked:** "Push fails once" → Blocked with the command → scan → Resume →
      Review.
- [ ] **Keyboard** (`keyboard.spec.ts`): the colours task by keyboard alone — Tab to the card,
      Enter, arrow to Approvals, Tab to the option, Enter; assert focus lands on the state line
      and the status text; then Tab order through the panel matches §11.
- [ ] Run `./run test:ui`; commit `test(ui): answer, resume and cancel paused cards in the browser`.

### Task 27: Smoke, by hand, on the subscription

Not automated; its outcome goes in the slice's review.

- [ ] `ANTHROPIC_API_KEY` unset; `./run dev`; a scratch target repository with a test command.
- [ ] One task whose spec leaves the retry count unstated and says the agent must ask. Approve;
      watch it reach Needs approval; answer on the board; it reaches Review with a pull
      request. The Cost tab: every phase within 2%, or the pause's phase within 2% since it
      ended by itself.
- [ ] During that run, sleep the laptop for three minutes (`pmset sleepnow`); on waking, the
      card must not be Blocked.
- [ ] Stop the daemon with Ctrl-C mid-phase: Blocked "runner stopped"; start it; Resume; it
      completes, its phase marked interrupted.
- [ ] Record what happened, with the costs, for the review. A failure is a backlog entry or a
      fix before closing — not an edited result.

### Task 28: Documentation, and the plan archived

- [ ] `docs/architecture.md`: the lifecycle line gains Needs approval and Blocked; "A run"
      describes stages, checkpoints, pauses, releases and resumes; "What the runner reports"
      gains checkpoints, blocks, the paused marker; "Costs" gains sessions, the baseline, cut
      messages and interrupted phases; "Security" gains the paused guard; "Accessibility" gains
      the Approvals tab's focus rules.
- [ ] `README.md`: the new configuration — `SWEEP_MS`, `PAUSE_GRACE_MS`, `STOP_GRACE_MS`,
      `MARKER_POLL_MS` — and that stopping the daemon blocks its run.
- [ ] Check `docs/backlog.md` lists none of the four fixed entries.
- [ ] `git mv docs/superpowers/plans/2026-10-20-slice-2-pause-and-resume.md docs/superpowers/plans/archive/`.
- [ ] The MVP design's status line: slice 2 shipped.
- [ ] Run `./run check`; commit `docs: describe the board as slice 2 built it`.
- [ ] The session's review, as the kit's review rule asks: the changes shown, what ran and its
      output, every deviation from this plan, and what is still unproven — a screen reader,
      200% zoom and 320 px on the Approvals tab among it unless tried.
