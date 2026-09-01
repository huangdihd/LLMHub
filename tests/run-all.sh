#!/bin/sh
# Runs all protocol tests. No test framework needed:
# - parsers/serializers run directly via Node's native TS type-stripping
# - adapters use TS parameter properties, so they are precompiled with tsc first
set -e
cd "$(dirname "$0")/.."

BUILD_DIR="${TMPDIR:-/tmp}/llmhub-test-build"
rm -rf "$BUILD_DIR"

echo "== compiling adapters (tsc) =="
npx tsc .nuxt/types/nitro-imports.d.ts \
  server/providers/openai.ts server/providers/claude.ts server/providers/gemini.ts server/providers/codex.ts \
  server/providers/loader.ts \
  server/utils/codex-auth.ts \
  server/protocols/gemini-generate.ts server/protocols/gemini-generate-serializer.ts \
  --outDir "$BUILD_DIR" \
  --module commonjs --target es2022 --moduleResolution node \
  --esModuleInterop --skipLibCheck

FAIL=0
for t in tests/*.test.ts; do
  echo ""
  echo "== $t =="
  ADAPTER_BUILD="$BUILD_DIR" node "$t" || FAIL=1
done

echo ""
if [ "$FAIL" = "1" ]; then
  echo "RESULT: FAILED"
  exit 1
fi
echo "RESULT: ALL PASSED"
