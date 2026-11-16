---
name: board-priority
description: Place a task in its project's Backlog by priority, against the tasks already there. Use whenever a session adds a task to the board, findings included, and whenever the owner asks to set, change or explain priorities.
disable-model-invocation: true
---

# Board priority

A task's priority is its place in the Backlog column: the board orders a column by `position`,
lowest first, and the owner works from the top. Setting a priority means choosing the two tasks
it goes between. It never means "important, so first": every task in the column was important to
someone, and a task is placed by comparing it with its neighbours.

## The order of the Backlog

The AIDP Backlog runs in groups, by what a task costs the owner while it stays undone. The order
of the groups is the owner's; it was read off the board on 2026-11-16. Top to bottom:

1. **A decision the owner cannot make well**: a gate that hides what is needed to decide, or
   Verify judging the work wrongly.
2. **A run stopped or misled by something outside the code**: a test command failing for its
   environment, output cut short.
3. **An agent going past what the owner allowed**, and a failure that does not say why.
4. **The board getting in the owner's way**: cards, columns and layout as the board grows.
5. **A run doing the wrong thing in a corner case**: the guard missing a path, commits,
   migrations, handoffs, stopping and timeouts.
6. **Runs costing more than they need**: money, tokens and time — models, context, the prompt
   cache, budgets, test time.
7. **A gap in the owner's flow that has a workaround**: no way to send back, go back to the spec,
   add a note to an approval, or redo in one step.
8. **Races, lock order and duplicated logic** that let fixes drift apart.
9. **Test hygiene**: flaky tests, test code nothing checks.
10. **Accessibility and small interface defects.**
11. **New capabilities nobody is blocked without**: search, deletion, imports, attachments,
    parallel runs.
12. **Tidy-ups**: naming, wording, leftover copies.

The groups are a guide, not fences: their edges move as tasks are added and done. When the owner
moves tasks in a way these groups do not explain, ask why and update this list in the same
session.

Another project's board (`CHR`, `ZLC`, `ZLR`, any other) is placed the same way, against the
order its own Backlog already has; this list is AIDP's.

## Placing a task

1. **Read the column as it is now**: `GET /api/projects/<KEY>/tasks`, the Backlog tasks sorted
   by `position`, not by key. Never place from memory of an earlier read.
2. **Find its group** by asking what leaving the task undone costs, not what kind of change it
   is. A test-time task belongs with the costs (6), not with the test command's failures (2).
3. **Place it inside the group** by comparing it with each neighbour: if both were left undone
   for a month, which would the owner miss more? A task that takes in others ranks as the
   highest of them. Within a group, these go first:
   - a task whose outcome changes what another is worth, such as a measurement before the slice
     it might make unnecessary;
   - the cheaper of two fixes with the same payoff;
   - a task that unblocks others.
4. **Urgency in the conversation is not a group.** When the owner has just raised a problem, put
   its task at the head of its own group and say so; put it above other groups only when the
   owner asks for that.
5. **Set the position** between the two neighbours with `PATCH /api/tasks/:id`
   `{ "position": <n> }`; a fraction is fine (between 21 and 22, use 21.5). A new task lands at
   the bottom of Backlog, so every task a session adds is placed straight after it is created.
   Never renumber the column: Prioritise (`POST /api/projects/:key/tasks/reorder`) is the
   owner's button.
6. **Read the column again** and check each placed task sits between the tasks you meant.

## Reporting

For each task placed, say:

- its position, and the tasks just before and after it;
- its group, and the reason it sits where it does inside that group;
- any call that is the owner's: a task that could fit two groups, or a trade such as money
  against time. Give the other position it would take, so the owner can move it in one step.
