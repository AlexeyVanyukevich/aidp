# Backlog

What is known to be wrong and not yet fixed, newest first. The rule for this file is the kit's
`core/rules/backlog.md`: one entry per finding, deleted by the commit that fixes it.

## A run that reaches the subscription's usage limit fails instead of waiting

- Where: `runner/src/phases/phase.ts`, which treats every failed `claude` process alike; slice
  2's blocks in `docs/superpowers/specs/2026-10-19-pause-and-resume-design.md`, §8
- Found: 2026-10-19, recording streams for slice 2
- Problem: the runner signs in with the owner's claude.ai plan, whose every process reports a
  `rate_limit_event` — a five-hour and a seven-day window, overage disabled for the
  organisation. Once a window is used up, requests are refused rather than billed. A phase
  refused that way ends like any failed phase: the card moves to Failed, and Re-run starts again
  from Plan, throwing away the session and every phase already paid for. How a refused request
  appears in the stream — the event's `status`, the result's subtype — is not recorded; seeing
  it means reaching the limit.
- Impact: a long run near the end of a window loses its work, and the window's reset is not on
  the card. Blocking the run with the reset time, and continuing the session on Resume, would
  reuse slice 2's checkpoints; it needs one recording of a refused request first.

## The kit's Field grows its label and input when its grid row is taller

- Where: `@zellige/core` 0.1.1, `css/field.css`: `.zl-field` is a grid with no
  `align-content`
- Found: 2026-10-19, the registration form's inputs out of line
- Problem: placed in a grid that stretches its items, a Field shorter than its row spreads the
  spare height over its own label, input and hint rows. Beside a field whose hint wraps to two
  lines, the input sits lower and taller than its neighbours. `web/src/styles.css` works round
  it with `align-items: start` on the registration form.
- Impact: every form laid out in a grid has to repeat the workaround until the kit sets
  `align-content: start` on `.zl-field`; the fix belongs in the kit's repository.

## An unauthenticated runner request with a bad body answers 400, not 401

- Where: `server/src/modules/runner/runner.routes.ts`, where the key and token checks are
  `preHandler` hooks
- Found: 2026-10-19, closing slice 1
- Problem: Fastify validates the body before `preHandler` runs. `POST /api/runner/claim` with
  no `Authorization` header and `{}` as its body answers `400 validation_error` with the schema
  issues, instead of the one identical `401` the kit's HTTP rule asks for.
- Impact: small, on a loopback-only server: an unauthenticated caller learns the shape of the
  runner endpoints. Moving the checks to `preValidation` closes it.

## The PR tab's file list answers 500 when GitHub does not know the repository

- Where: `server/src/modules/runs/pr-files.ts`
- Found: 2026-10-18, running the browser journeys
- Problem: a failing `gh pr view` — an unknown repository, no network, `gh` signed out — throws
  a plain `Error`, which the error handler logs with its stack as unexpected and answers
  `500 internal_error`. The journeys hit it on every run, since `owner/pay` does not exist.
- Impact: the tab handles it and says GitHub did not list the files, but the server log reads
  as if something broke, and a real outage looks like every other 500.

## A runner that dies leaves its card in Running

- Where: `server/src/modules/runner/`, which records heartbeats and has no sweeper
- Found: 2026-10-11, planning slice 1
- Problem: heartbeats are stored but nothing reads them. Kill the daemon mid-run: the card
  stays in Running and its run in `running`. Cancel moves the card; the run row stays
  `running` with `cancel_requested`.
- Impact: until slice 2's lost-runner sweeper, a crash needs a Cancel and a Re-run by hand.

## Cache writes are priced at one rate

- Where: `prices.cache_write`, `server/scripts/set-price.ts`
- Found: 2026-10-11, reading recorded runs
- Problem: Anthropic prices a one-hour cache write higher than a five-minute one. Claude Code
  2.1.212 wrote only one-hour entries in the recordings, so the row holds that rate. A run
  that writes five-minute entries is over-priced on them, and its phase drifts from Claude
  Code's own figure.
- Impact: the 2% flag fires on such phases. The usage counters stay exact; only the price is
  off. Splitting `cache_write` by TTL needs the breakdown `message_start` carries.

## The platform design's two diagrams are missing from its copy

- Where: `docs/superpowers/specs/2026-10-08-platform-design.md`, the lines reading "Diagram in
  the source doc: run flow" (in "Spec-based workflow") and "Diagram in the source doc:
  architecture" (in "Architecture and API")
- Found: 2026-10-10, converting the platform design from the shared document it was written in
- Problem: the source document drew both as live widgets, which have no Markdown form. The copy
  keeps their captions and loses the pictures: the run flow with its approval lane, and the core,
  gateway and three runners.
- Impact: small. The surrounding prose and tables carry the same content, and the MVP spec does
  not rely on either picture. A reader of the copy sees a caption where a diagram was.
