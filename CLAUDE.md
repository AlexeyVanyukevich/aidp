# aidp

A board where Claude carries out each task through Spec → Plan → Build → Verify, for one owner
on their own machine.

## The documentation

`docs/architecture.md` is authoritative for what the board does today; Slice 1 creates it. The
decision record is `docs/superpowers/specs/2026-10-10-mvp-design.md` — read it for _why_, never
for what the code does. What is known to be wrong is on the board, as AIDP tasks; read them
before planning.

## Conventions

The shared ones come from the `charter` package. `core` loads here, always, except its backlog
rule, which this repository replaces with the one below. Each workspace's other modules,
recorded in `charter.json`, load by path: a rule arrives once a session reads a file it applies
to. Start sessions at the repository root, where one session works on every workspace: a
session started in a workspace gets all of `core` from its sync hook, backlog rule included.
`charter init` adds `@node_modules/charter/core/rules.md` back to this file; remove it again.

@node_modules/charter/core/rules/commits.md
@node_modules/charter/core/rules/documentation.md
@node_modules/charter/core/rules/writing.md
@node_modules/charter/core/rules/review.md
@node_modules/charter/core/rules/testing.md

`CONTRIBUTING.md` holds this repository's own conventions.

UI components come from the `@zellige/react` package, on `@zellige/core`'s tokens and CSS. A
widget the kit lacks is added to the kit, in its own repository, never written in `web/`.

## Findings

**Anything found and not fixed becomes a task on the board, in the AIDP project** — a bug
noticed on the way past, a missing test, a document that has drifted, a shortcut taken on
purpose. Not a file, not the chat, not the commit message, not a bare `TODO`. The board must be
running (`./run dev`):

    curl -s -X POST http://127.0.0.1:4100/api/projects/AIDP/tasks \
      -H 'content-type: application/json' --data @finding.json

with `{"title": …, "description_md": …}`. The title says what is wrong, in 200 characters or
fewer. The description is written for someone who was not there, as four items: **Where** (file
and function), **Found** (date, and while doing what), **Problem** (what is wrong and how to see
it), **Impact** (what it costs). A finding in another repository — the component kit, `charter`
— is an issue on that repository instead.

**Record what is outside the task; do not fix it in passing.** A fix nobody asked for is an
unreviewed change inside an unrelated commit. If it blocks the task, it is part of the task.

**Read the board before planning a slice:** `GET /api/projects/AIDP/tasks` lists every task and
its state. A task touching the same code is either taken into the plan or left there knowingly.
A code comment may point at a task by its key, never stand in for one.

A fix made outside the task's own run is closed by marking the task done, from its card or with
`PATCH /api/tasks/:id` `{ "state": "done" }`. Name the task the fix settles in the session's
review, so the owner can.
