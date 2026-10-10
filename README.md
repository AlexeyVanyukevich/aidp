# AI Task Board

A Jira-style board where Claude carries out each task through Spec → Plan → Build → Verify. The
owner approves every spec, answers the questions a run cannot settle itself, and sees every step
and token a run spent. Every run ends in a pull request a person reviews.

It runs on the owner's machine: a web app and API server over PostgreSQL, and a runner daemon
that drives Claude Code in git worktrees of the owner's repositories.

## Status

**Designed, not built.** Nothing here runs yet.

- [docs/superpowers/specs/2026-10-10-mvp-design.md](docs/superpowers/specs/2026-10-10-mvp-design.md)
  is the decision record for the first release — read §13 for the build order.
- [docs/superpowers/specs/2026-10-08-platform-design.md](docs/superpowers/specs/2026-10-08-platform-design.md)
  is the platform design it was cut from, covering all five roadmap phases.

## Conventions

This repository follows the shared `dev-kit` package, from `v2.2.0`. Slice 1 installs it and
loads its sections; until then, the rules are in that package's README.
