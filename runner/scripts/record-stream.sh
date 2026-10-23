#!/usr/bin/env bash
#
# Records the stream fixtures from the real claude CLI, signed in with the owner's subscription:
# it refuses to run with ANTHROPIC_API_KEY set. Haiku and Sonnet, each process capped by
# --max-budget-usd. Re-run when Claude Code's output changes; never edit the fixtures by hand.
#
#   record-stream.sh [slice1|pauses|specs|all]     default: all
#
# `slice1` records one plain process and one with a subagent. `pauses` records a session paused
# and resumed, and processes stopped by a signal with their resumes (slice 2 spec, §3). `specs`
# records an Opus spec-writer asking a batch, resumed with the answers, and one with nothing to
# ask (slice 3 spec, §13).
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

if [ "$SET" = specs ] || [ "$SET" = all ]; then
  # The spec-writer's whole call, against a stand-in board and a repository with one small file
  # whose retries the description leaves open: how many, how far apart, which errors.
  cat > "$WORK/mcp.json" <<EOF
{"mcpServers":{"board":{"type":"stdio","command":"node","args":["$HERE/board-stub.mjs"]}}}
EOF
  mkdir -p "$WORK/src"
  cat > "$WORK/src/fetch-json.ts" <<'EOF'
export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return (await response.json()) as T
}
EOF
  git -C "$WORK" add -A && git -C "$WORK" -c user.name=rec -c user.email=rec@example.com commit -qm init
  WRITER='You write the spec for one task of a board, from its description and the code. Read the code the task touches first. Collect every question the description and the code leave open and ask them together, in one request_approval call with kind "questions": each with up to five options, the one you recommend, and what the owner needs to choose. Do not guess an answer. When the tool says the run is paused, end your turn at once; the answers arrive as your next message. Then save the spec with save_spec: sections Goal, Context, Requirements (R1, R2…), Acceptance criteria (AC1 (R1): Given … When … Then …), Out of scope, Constraints, and an empty Open questions. Finish with one paragraph.'
  TOOLS=Read,Grep,Glob,mcp__board__request_approval,mcp__board__save_spec
  FLAGS=(--agents "$(node -e 'console.log(JSON.stringify({"spec-writer":{description:"Drafts a task’s spec.",model:"opus",tools:process.argv[2].split(","),prompt:process.argv[1]}}))' "$WRITER" "$TOOLS")"
    --agent spec-writer --model opus --effort high --permission-mode default
    --allowedTools "$TOOLS"
    --mcp-config "$WORK/mcp.json" --strict-mcp-config --setting-sources project
    --max-budget-usd 2.00 --include-partial-messages --output-format stream-json --verbose)
  ASK='<task id="REC-1" phase="spec" attempt="1">Retry failed requests</task>
<description>fetchJson in src/fetch-json.ts gives up at the first failure. Make it retry.</description>
<return_format>Call save_spec until the lint is clean, then reply with one paragraph.</return_format>'
  ANSWERS='The owner answered your questions: take the option you recommended for each one. Save the spec now.'
  PLAIN='<task id="REC-2" phase="spec" attempt="1">Rename fetchJson</task>
<description>Rename fetchJson in src/fetch-json.ts to getJson. Nothing else changes; there are no callers.</description>
<return_format>Call save_spec until the lint is clean, then reply with one paragraph.</return_format>'
  drive() { ( cd "$WORK" && "$HERE/../../node_modules/.bin/tsx" "$HERE/record-driver.ts" "$@" ); }
  session() { uuidgen | tr '[:upper:]' '[:lower:]'; }

  s=$(session)
  drive --out "$OUT/spec-1.ndjson" -- -p "$ASK" --session-id "$s" "${FLAGS[@]}"
  drive --out "$OUT/spec-2.ndjson" -- -p --resume "$s" "$ANSWERS" "${FLAGS[@]}"
  drive --out "$OUT/spec-plain.ndjson" -- -p "$PLAIN" --session-id "$(session)" "${FLAGS[@]}"

  scrub "$OUT"/spec-*.ndjson
  for f in "$OUT"/spec-*.ndjson; do
    models=$(grep '"type":"result"' "$f" | tail -1 | grep -o '"claude-[a-z0-9-]*":{' | tr -d '":{' | tr '\n' ' ' || true)
    echo "recorded $f ($(wc -l < "$f") lines; models: ${models:-none})"
  done
fi
