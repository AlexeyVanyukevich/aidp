#!/usr/bin/env bash
#
# Records the stream fixtures from the real claude CLI, signed in with the owner's subscription:
# it refuses to run with ANTHROPIC_API_KEY set. Haiku and Sonnet, each process capped by
# --max-budget-usd. Re-run when Claude Code's output changes; never edit the fixtures by hand.
#
#   record-stream.sh [slice1|pauses|all]     default: all
#
# `slice1` records one plain process and one with a subagent. `pauses` records a session paused
# and resumed, and processes stopped by a signal with their resumes (slice 2 spec, §3).
set -euo pipefail
SET="${1:-all}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/.." && pwd)/tests/fixtures/stream"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY is set: recordings go through the subscription, not the API" >&2
  exit 1
fi
mkdir -p "$OUT"
git -C "$WORK" init -q

# The home directory appears in an init line's paths; the fixtures keep `~` in its place.
scrub() { sed -i '' "s|$HOME|~|g" "$@"; }

record() {
  local name="$1" prompt="$2"; shift 2
  echo '{"mcpServers":{}}' > "$WORK/mcp.json"
  ( cd "$WORK" && claude -p "$prompt" --model haiku --setting-sources project \
      --mcp-config "$WORK/mcp.json" --strict-mcp-config --max-budget-usd 0.10 \
      --include-partial-messages --output-format stream-json --verbose "$@" ) > "$OUT/$name.ndjson"
  scrub "$OUT/$name.ndjson"
  echo "recorded $OUT/$name.ndjson ($(wc -l < "$OUT/$name.ndjson") lines)"
}

if [ "$SET" = slice1 ] || [ "$SET" = all ]; then
  record plain "Reply with the single word ready."
  record subagent "Call the echoer agent exactly once with the text 'ping', with run_in_background false, and wait for its answer. Then reply with the single word done." \
    --allowedTools Agent \
    --agents '{"echoer":{"description":"Echoes text back.","prompt":"Reply with the word pong and nothing else. Use no tools.","tools":["Read"],"model":"haiku"}}'
fi

if [ "$SET" = pauses ] || [ "$SET" = all ]; then
  # The runner's whole call, with a stand-in board and one role. The role's prompt asks for a
  # fixed last word, which shows in a resumed reply whether the role survived the resume.
  cat > "$WORK/mcp.json" <<EOF
{"mcpServers":{"board":{"type":"stdio","command":"node","args":["$HERE/board-stub.mjs"]}}}
EOF
  FLAGS=(--agents '{"worker":{"description":"Carries out the recording.","model":"sonnet","tools":["mcp__board__request_approval","mcp__board__note"],"prompt":"You are the worker. End every reply you write with the word KIWI on its own line."}}'
    --agent worker --model sonnet --effort medium --permission-mode default
    --allowedTools mcp__board__request_approval,mcp__board__note
    --mcp-config "$WORK/mcp.json" --strict-mcp-config --setting-sources project
    --max-budget-usd 0.50 --include-partial-messages --output-format stream-json --verbose)
  ASK="Call request_approval once, with the question 'Which colour should the button be?' and the options 'red' and 'blue'. Follow what the tool tells you."
  ANSWER="The owner answered: blue. Reply with one sentence."
  LONG="Call note with the text 'one', then 'two', then 'three'. Then write a 300-word story about a lighthouse keeper."
  AGAIN="You were interrupted. Reply with the single word done."
  drive() { ( cd "$WORK" && "$HERE/../../node_modules/.bin/tsx" "$HERE/record-driver.ts" "$@" ); }
  session() { uuidgen | tr '[:upper:]' '[:lower:]'; }

  s=$(session)
  drive --out "$OUT/pause-1.ndjson" -- -p "$ASK" --session-id "$s" "${FLAGS[@]}"
  drive --out "$OUT/pause-2.ndjson" -- -p --resume "$s" "$ANSWER" "${FLAGS[@]}"

  for stop in term kill; do
    s=$(session)
    drive --out "$OUT/$stop-1.ndjson" --stop "$stop" --at text:30 -- -p "$LONG" --session-id "$s" "${FLAGS[@]}"
    drive --out "$OUT/$stop-2.ndjson" -- -p --resume "$s" "$AGAIN" "${FLAGS[@]}"
  done

  s=$(session)
  drive --out "$OUT/gone-1.ndjson" --stop kill --at init -- -p "$LONG" --session-id "$s" "${FLAGS[@]}"
  drive --out "$OUT/gone-2.ndjson" --stderr "$OUT/gone.stderr" -- -p --resume "$s" "$AGAIN" "${FLAGS[@]}"

  s=$(session)
  drive --out "$OUT/chain-1.ndjson" -- -p "$ASK" --session-id "$s" "${FLAGS[@]}"
  drive --out "$OUT/chain-2.ndjson" --stop kill --at text:30 -- -p --resume "$s" "The owner answered: blue. $LONG" "${FLAGS[@]}"
  drive --out "$OUT/chain-3.ndjson" -- -p --resume "$s" "$AGAIN" "${FLAGS[@]}"

  scrub "$OUT"/pause-*.ndjson "$OUT"/term-*.ndjson "$OUT"/kill-*.ndjson "$OUT"/gone-*.ndjson \
    "$OUT"/chain-*.ndjson "$OUT/gone.stderr"
  for f in "$OUT"/{pause,term,kill,gone,chain}-*.ndjson; do
    models=$(grep '"type":"result"' "$f" | tail -1 | grep -o '"claude-[a-z0-9-]*":{' | tr -d '":{' | tr '\n' ' ' || true)
    echo "recorded $f ($(wc -l < "$f") lines; models: ${models:-none})"
  done
fi
