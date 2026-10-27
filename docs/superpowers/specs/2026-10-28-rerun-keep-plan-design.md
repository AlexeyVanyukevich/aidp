# Re-run keeps the accepted plan

Status: **built**, 2026-10-28; approved and designed 2026-10-28. Builds on the slices as
[docs/architecture.md](../../architecture.md) describes them on that date.

> **This is a decision record, not a description of the system.**
>
> It states what was decided on 2026-10-28, before any of it was built. It is not revised as
> the code moves on.
>
> Read it to learn **why** something has the shape it does. For **what** the system does today,
> read [docs/architecture.md](../../architecture.md). Where the two disagree, the architecture
> document is right and this one is stale.

## Why

A delivery run's plan went through four rounds at the plan gate, the run then failed for a reason
outside the plan, and the next run's planner started from the spec alone and lost every
correction. A Re-run now chooses between planning again, with the earlier plans in front of the
planner, and keeping the plan the owner already accepted.

## Decisions

- **An approval is tied to a plan by exact text, within the run.** A phase can hold several
  plans, and an answered approval carries no pointer to the plan it showed; its context is that
  plan's text. Phase and time were rejected as ties: both guess.
- **A copy is a plan of its own** in the new run, with the source run's number in a nullable
  column `artifacts.copied_from_run`, rather than a pointer to the old artifact. Every reader of
  a run's plan (checkpoint, allowed files, handoffs, the Plan tab) works unchanged.
- **Allowances and migration approvals are not carried.** They are keyed by run, and the new
  run's Build asks again.
- **The kept plan is not checked against the base branch.** Doing so is a design of its own.
- **Errors for the Re-run body are checked by hand** in a static route, so a request without a
  body keeps working.
