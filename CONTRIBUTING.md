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

## Commit scopes

`db`, `server`, `mcp`, `runner`, `web`, `ui` for the browser journeys, `deps`. Omit the scope
when the change is repository-wide.

## Before committing

`./run check` — types, formatting, the web app's lint, and every workspace's suite. It needs
Docker running. A change to the web app also runs `./run test:ui`, the browser journeys.
