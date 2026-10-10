# Backlog

What is known to be wrong and not yet fixed, newest first. The rule for this file is the kit's
`common/rules/backlog.md`: one entry per finding, deleted by the commit that fixes it.

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
