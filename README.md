# AI Task Board

A Jira-style board where Claude carries out each task through Spec → Plan → Build → Verify. The
owner approves every spec, answers the questions a run cannot settle itself, and sees every step
and token a run spent. Every run ends in a pull request a person reviews.

It runs on the owner's machine: a web app and API server over PostgreSQL, and a runner daemon
that drives Claude Code in git worktrees of the owner's repositories.

## Status

**Slices 1 and 2 built:** one task from the board to a pull request, and runs that pause on a
question, wait in Blocked when interrupted, and resume. Drafted specs are slice 3 — see §13 of
the [MVP spec](docs/superpowers/specs/2026-10-10-mvp-design.md). What the board does today is in
[docs/architecture.md](docs/architecture.md).

## Running it

Needs Node 24, Docker, Claude Code signed in, and the GitHub CLI signed in (`gh auth login`).

    ./run dev            # PostgreSQL, the server, the web app and the runner
    open http://127.0.0.1:5174

Register a repository on the Projects page, then record the price of each model the phases
use, from Anthropic's price list, in USD per million tokens:

    ./run price:set <model id> <input> <output> <cache read> <cache write>

The Cost tab names any model that still has no price.

Stopping the runner's daemon mid-run — SIGINT or SIGTERM, as Ctrl-C at its terminal sends —
blocks the run it was carrying out rather than failing it: start the runner again and press
Resume on the card. The timings that govern
pauses and blocks have defaults, and can be set in `.env`:

| Setting          | Default | What it is                                                    |
| ---------------- | ------- | ------------------------------------------------------------- |
| `SWEEP_MS`       | 60 000  | How often the server looks for lost runners and old questions |
| `PAUSE_GRACE_MS` | 60 000  | How long a paused `claude` has to end its turn                |
| `STOP_GRACE_MS`  | 10 000  | How long a stopped `claude` has between SIGTERM and SIGKILL   |
| `MARKER_POLL_MS` | 500     | How often the runner looks for the paused marker              |

    ./run check          # types, formatting, lint, every suite (needs Docker)
    ./run test:ui        # the browser journeys, with a fake claude
    ./run smoke          # one real task against a throwaway repository; spends tokens

The smoke run needs a GitHub repository you can throw away, cloned locally with `main` pushed,
and the board running (`./run dev --bg`). Name both in `.env`:

    SMOKE_REPO_PATH=/path/to/the/clone
    SMOKE_GITHUB_REPO=owner/name

It opens a real pull request there. With Claude Code signed in to a Claude subscription, its
phases count against the subscription's usage rather than per-token billing.

## Conventions

This repository follows the shared `charter` package, at `v3.3.0`: `charter.json` records which
of its modules each workspace takes, and `CONTRIBUTING.md` holds this repository's own
conventions. The web app's widgets come from the zellige component kit.
