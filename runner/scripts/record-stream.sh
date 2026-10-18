#!/usr/bin/env bash
#
# Records the stream fixtures from the real claude CLI. Spends a few cents of the owner's
# account with Haiku, capped at $0.10 a recording. Re-run when Claude Code's output changes;
# never edit the fixtures by hand.
set -euo pipefail
OUT="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures/stream"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"
git -C "$WORK" init -q
echo '{"mcpServers":{}}' > "$WORK/mcp.json"

record() {
  local name="$1" prompt="$2"; shift 2
  ( cd "$WORK" && claude -p "$prompt" --model haiku --setting-sources project \
      --mcp-config "$WORK/mcp.json" --strict-mcp-config --max-budget-usd 0.10 \
      --include-partial-messages --output-format stream-json --verbose "$@" ) > "$OUT/$name.ndjson"
  echo "recorded $OUT/$name.ndjson ($(wc -l < "$OUT/$name.ndjson") lines)"
}

record plain "Reply with the single word ready."
record subagent "Call the echoer agent exactly once with the text 'ping', with run_in_background false, and wait for its answer. Then reply with the single word done." \
  --allowedTools Agent \
  --agents '{"echoer":{"description":"Echoes text back.","prompt":"Reply with the word pong and nothing else. Use no tools.","tools":["Read"],"model":"haiku"}}'
