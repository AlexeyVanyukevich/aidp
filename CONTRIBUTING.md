# Contributing

The conventions this project shares with its siblings come from the `charter` package and are
not restated here. After `npm install`, or the first `./run`, which does it, they are in
`node_modules/charter/`. `charter.json` says which of its modules each workspace takes.
Everything below is this repository's own.

## Layout

`server/`, `runner/` and `web/` are npm workspaces. The server follows the kit's backend
layout; tests sit in each workspace's `tests/{unit,integration}/`, and the browser journeys,
which drive the whole product, at the root in `tests/ui/`.

## The runner's copy of the wire types

`runner/src/contract.ts` repeats the shapes the server's runner and MCP endpoints accept. The
scenario tests in `runner/tests/integration/` run the runner against the real server, and they
are what catches the two drifting apart. Change both in the same commit.

## Reviewing at the board's gates

`.claude/skills/gate-review/` says how a session reviews a task waiting at a gate (a spec, a
plan, open questions, approvals or a pull request) and hands back the note to act on. The
skill is marked `disable-model-invocation`, so no session lists it. The `UserPromptSubmit` hook
in `.claude/settings.json` puts the skill's text into the owner's session whenever a prompt asks
for such a review, and the owner can load the skill by hand with `/gate-review`. The hook does
nothing in a board run's sessions, where `BOARD_RUN_ID` is set.

## Placing tasks by priority

`.claude/skills/board-priority/` says what a task's priority is (its place in Backlog, between two
neighbours), the order of the groups AIDP's Backlog runs in, and how a session places a task it
adds. It is marked `disable-model-invocation` like the gate-review skill, so board runs' agents
do not list it; the Findings rule in `CLAUDE.md` sends every session that adds a task to it, and
the owner can load it by hand with `/board-priority`. When the owner's order stops matching its
groups, change the list there.

## Commit scopes

`db`, `server`, `mcp`, `runner`, `web`, `ui` for the browser journeys, `deps`. Omit the scope
when the change is repository-wide.

## Before committing

`./run check` — types, formatting, the web app's lint, and every workspace's suite. It needs
Docker running. A change to the web app also runs `./run test:ui`, the browser journeys; `./run check:all`
runs both, and is what `npm test` runs.
