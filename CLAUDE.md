# aidp

A board where Claude carries out each task through Spec → Plan → Build → Verify, for one owner
on their own machine.

## The documentation

`docs/architecture.md` is authoritative for what the board does today; Slice 1 creates it. The
decision record is `docs/superpowers/specs/2026-10-10-mvp-design.md` — read it for _why_, never
for what the code does. `docs/backlog.md` lists what is known to be wrong; read it before
planning.

## Conventions

The shared ones come from the `charter` package. `core` loads here, always. Each workspace's
other modules, recorded in `charter.json`, load by path: a rule arrives once a session reads a
file it applies to. Start sessions at the repository root, where one session works on every
workspace.

@node_modules/charter/core/rules.md

`CONTRIBUTING.md` holds this repository's own conventions.

UI components come from the `@zellige/react` package, on `@zellige/core`'s tokens and CSS. A
widget the kit lacks is added to the kit, in its own repository, never written in `web/`.
