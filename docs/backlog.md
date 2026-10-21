# Backlog

What is known to be wrong and not yet fixed, newest first. The rule for this file is the kit's
`core/rules/backlog.md`: one entry per finding, deleted by the commit that fixes it.

## A builder that backgrounds a long command and ends its turn loses the work

- Where: `runner/src/phases/agents.ts`, the phases' prompts and tools; Claude Code's `Bash` tool
  moves a long command into the background
- Found: 2026-10-21, the slice 2 smoke run: a spec asked the builder to run `sleep 150`
- Problem: Claude Code ran the command in the background, and the builder ended its turn
  "waiting for the background sleep to complete". In `-p` mode, ending the turn ends the
  process: nothing was committed, the attempt counted as a failed verify, and after three
  attempts the run failed. A real slow command — a long test suite, a build — can go the same
  way.
- Impact: a run fails, at the cost of every attempt, for work the agent never finished. The
  phases' prompts could tell agents to wait for a background command before ending their turn,
  or the runner could refuse to end a phase while one is still running.

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
