# Backlog

What is known to be wrong and not yet fixed, newest first. The rule for this file is the kit's
`core/rules/backlog.md`: one entry per finding, deleted by the commit that fixes it.

## Stopping the runner through `./run` is not tested to block its run

- Where: `run`, `scenario_stop` and `scenario_dev`; `runner/src/daemon.ts`, `main()`
- Found: 2026-10-21, closing slice 2
- Problem: a run is blocked as `runner_stopped` when its daemon gets SIGINT or SIGTERM itself:
  the scenario tests and the slice 2 smoke run proved that. `./run stop` signals the
  `npm run daemon` process instead, and Ctrl-C under `./run dev` sends SIGTERM to the whole
  process group through its trap. Whether npm and tsx pass the signal on to the daemon, and let
  it block its run before they exit, is untried.
- Impact: if they do not, the run is still recoverable: the sweeper blocks it as `runner_lost`
  90 seconds later, its phase marked interrupted. But the card names the wrong cause, and the
  README promises the right one. A scenario that starts the daemon through `npm run`, stops it,
  and reads the block would settle it.

## The sweeper's sleep rule is not shown to work on a sleeping machine

- Where: `server/src/modules/runs/sweeper.ts`, `server/src/modules/runs/sweep-rules.ts`
- Found: 2026-10-21, the slice 2 smoke run
- Problem: the rule — a tick after a gap longer than two intervals decides nothing — is tested
  only with an injected clock. In the smoke run the machine slept six minutes during a run and
  the card stayed out of Blocked, but nothing in the logs says whether the rule held it or a
  heartbeat arrived first after waking: the sweeper logs nothing when it re-arms.
- Impact: small while the injected-clock tests pass. A debug line when the sweeper re-arms,
  and one more sleep during a run, would show the rule doing its work.

## The Approvals tab is untried with a screen reader, at 200% zoom and at 320 px

- Where: `web/src/card/ApprovalsTab.tsx`, `web/src/card/CardDrawer.tsx`
- Found: 2026-10-21, closing slice 2
- Problem: the browser journeys scan the tab with axe-core and answer by keyboard alone, but
  no one has listened to it: whether the options' fieldset is announced by the question, an
  option's impact as its description, and the answer and resume announcements in order. Nor has
  it been looked at zoomed to 200% or 320 px wide with a long question and five options.
- Impact: a WCAG 2.2 AA failure there — reflow, name or announcement — would be unknown. The
  MVP design asks for these to be tried by hand or named as untried; this entry names them.

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
