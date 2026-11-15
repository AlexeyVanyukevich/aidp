#!/usr/bin/env python3
"""UserPromptSubmit hook: when the prompt asks for a gate review or a note, inject the gate-review skill's rules."""
import json
import os
import re
import sys

# A board run's agents load this repository's settings too; the owner's review rules are not theirs.
if os.environ.get("BOARD_RUN_ID"):
    sys.exit(0)

try:
    prompt = json.load(sys.stdin).get("prompt", "")
except Exception:
    sys.exit(0)

GATE = re.compile(
    # Optional task keys ("aidp-12"), a bare project key, "please" or "again".
    r"^\s*(?:(?:[a-z]+-\d+|aidp|chr|zlc|zlr|please|pls|again)[\s,]+)*"
    r"(?:"
    r"r+e-?r?e?view|ve?w?rify"  # review, rreview, re-review, verify and their typos
    r"|giv(?:e)?(?:\s+me)?\s+an?\s+(?:answer\s+(?:with|and)\s+(?:a\s+)?)?note"
    r"|can\s+i\s+approve"
    r")\b"
    r"(?!\s+why\b)",  # "review why the run failed" is an investigation, not a gate
    re.IGNORECASE,
)

if not GATE.search(prompt):
    sys.exit(0)

# The skill is hidden from the model (disable-model-invocation), so its rules arrive here instead.
SKILL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", "gate-review", "SKILL.md")
try:
    with open(SKILL, encoding="utf-8") as f:
        text = f.read()
except OSError as e:
    # Exit 1 shows the problem without blocking the prompt; exit 2 would block it.
    print(f"gate-review hook: cannot read {os.path.normpath(SKILL)}: {e.strerror}", file=sys.stderr)
    sys.exit(1)

lines = text.splitlines(keepends=True)
if lines and lines[0].strip() == "---":
    closing = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if closing is not None:
        lines = lines[closing + 1:]
body = "".join(lines).lstrip("\n")

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": "This prompt is a gate review request. Follow the rules below.\n\n" + body,
    }
}))
