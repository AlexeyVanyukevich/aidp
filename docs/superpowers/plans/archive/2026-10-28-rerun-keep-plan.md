# Re-run keeps the accepted plan — plan

Executed 2026-10-28. Spent scaffolding, kept for provenance.

1. Migration 005: `artifacts.copied_from_run`, schema type, `ArtifactView` field.
2. Plan-history module: the pure classifier and selectors, and the queries that load earlier
   plans with their answered plan approvals.
3. Re-run with a body `{ plan }`: validation, the copy and the queued run in one transaction,
   `plan_to_keep` in the task view.
4. The claim carries `previous_plans` and `kept_plan` in start and resume work.
5. Runner: `<previous_plan>` tags in the planner's handoff; a copied plan skips the planner.
6. Planner instructions.
7. Web: two buttons, the Plan tab line, the Timeline entry.
8. Browser journeys for the Failed card.
9. Documentation.
