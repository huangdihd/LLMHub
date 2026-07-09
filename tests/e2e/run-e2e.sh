#!/bin/sh
# Full e2e run: mock upstream + built gateway + real-SDK tests.
# Usage: sh tests/e2e/run-e2e.sh          (builds .output if missing)
#        FORCE_BUILD=1 sh tests/e2e/run-e2e.sh
set -e
cd "$(dirname "$0")/../.."

export MOCK_PORT="${MOCK_PORT:-4000}"
GATEWAY_PORT="${GATEWAY_PORT:-3999}"
export GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"

if [ ! -d .output/server ] || [ -n "$FORCE_BUILD" ]; then
  echo "== building gateway =="
  npx nuxt build
fi

MOCK_PID=""
GW_PID=""
cleanup() {
  [ -n "$GW_PID" ] && kill "$GW_PID" 2>/dev/null || true
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  node tests/e2e/seed.mjs cleanup || true
}
trap cleanup EXIT INT TERM

echo "== starting mock upstream =="
node tests/e2e/mock-upstream.mjs &
MOCK_PID=$!

echo "== seeding .data =="
node tests/e2e/seed.mjs seed

echo "== starting gateway =="
GW_LOG="${TMPDIR:-/tmp}/llmhub-e2e-gateway.log"
PORT="$GATEWAY_PORT" HOST=127.0.0.1 node .output/server/index.mjs >"$GW_LOG" 2>&1 &
GW_PID=$!

echo "== waiting for gateway =="
i=0
until curl -sf -o /dev/null -H "Authorization: Bearer llmhub-e2e-test-key" "$GATEWAY_URL/api/openai/models"; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "gateway did not become ready; log follows:" >&2
    cat "$GW_LOG" >&2
    exit 1
  fi
  sleep 1
done

echo "== running SDK tests =="
node tests/e2e/sdk.test.mjs

echo "== running chat-page client contract tests =="
node tests/e2e/chat-clients.test.mjs
