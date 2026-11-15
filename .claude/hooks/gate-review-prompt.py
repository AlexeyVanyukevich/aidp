#!/usr/bin/env python3
"""UserPromptSubmit hook: when the prompt asks for a gate review or a note, load the gate-review skill."""
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

if GATE.search(prompt):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": (
                "This is a gate review request. Load the gate-review skill with the Skill tool "
                "before answering, and follow it."
            ),
        }
    }))
