---
name: gate-review
description: Review work waiting at an approval gate (a spec, a plan, open questions, approvals or a pull request) and hand back a verdict together with the note to act on. Use whenever the owner asks to review, review again, verify, or give a note on a task at a gate, or asks whether it can be approved.
disable-model-invocation: true
---

# Gate review

The owner decides at each gate; the agents did the work. A review exists to make that decision
quick and safe, and every extra round costs a full agent run. Optimise for the fewest rounds that
still catch what matters.

## Read before judging

- Fetch the current version from its source of truth, never from memory of an earlier one. When
  the version has changed since the last review, diff the two and judge the change.
- On a re-review, check each point of the previous note against the new version, one by one, and
  say which were taken, which were not, and what the redraft changed that nobody asked for.
- Check every claim the work makes about the code, the data or the board against the code, the
  data or the board. At the pull request gate, run the tests on the tree under review, and on
  each commit when the history will land on the main branch as it stands.
- For each acceptance criterion, name the change to the code that would make its Then false, and
  check that the criterion, and any test it names, would catch that change.

## Sort every finding

Give each finding exactly one destination, and say which:

- **Blocker**: left alone, the work would do the wrong thing or fail its own criteria. Worth
  another round at this gate.
- **Next gate**: wording, small gaps, or anything the next agent can settle without a decision.
  Never send it through a redraft round of its own. A note for a later gate needs a place on the
  board that takes the owner's words, and most gates have none: today Approve plan takes no
  words, and a plan saved at high confidence skips its gate. Approve spec takes a note for the
  planner. Check the board, and
  when the next gate cannot take the note, hand the point on in the first of these that applies:
  - this gate already needs a redraft: add the point to that redraft's note, at no extra round;
  - the gate takes a note for the next agent (Approve spec's note for the planner): write the
    point for that agent, in that note;
  - the owner can edit the work before approving it: give the edit, ready to paste;
  - otherwise: leave it to the pull request gate, and say that it waits there.
- **Outside the task**: record it where the repository's rules say findings go, and do not fold
  it into this task.

A gate with no blockers is ready, whatever the other findings are.

## Answer in one reply

- Lead with the verdict: ready, or changes needed, with the count of blockers.
- When changes are needed, end the same reply with the note, ready to paste, without waiting to
  be asked for it. Write it for the agent that will act on it: self-contained, one numbered
  point per finding, each saying what to change and why, and naming what must stay as it is.
- Give each point its evidence, as the place in the code (`path:line`), the command and the
  output line, or "not checked". The agent acting on the note can then check the point instead
  of taking it on trust, and the owner can see which points rest on a reading alone.
- Put each note in its own fenced code block tagged `text`, so it copies in one action and
  pastes as written: the note's text only, with no blockquote markers and no Markdown that
  relies on being rendered. Nothing else goes inside the block.
- Label every note with its destination (a redraft at this gate, an edit the owner makes before
  approving, or an answer at a later gate that takes words), on the line above its block, so that
  a note meant for one destination is never used at another.
- Before proposing a fix, test it against the cases it must not break. A suggested rule that
  makes correct work fail costs a round to undo.
- A re-review is short: the verdict, what changed, what is left, and the note when one is needed.
  Do not restate findings that were already settled.

## Leave the decision to the owner

- Never approve, redraft, merge, push or post on the owner's behalf unless asked to in that turn.
- Answer "can I approve?" from the evidence alone. Neither the owner's wish to move on nor this
  skill's aim of fewer rounds turns a blocker into a next-gate point.
- At the pull request gate, when the task can no longer go back to its run, offer to make the fix
  on the branch. After a yes, show what changed, prove the content is what was reviewed, run the
  tests, and report what the board's record of the run no longer matches.
- Report what is still unproven as plainly as what passed.
