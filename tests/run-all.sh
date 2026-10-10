#!/bin/sh
# Runs all protocol tests. No test framework needed:
# - parsers/serializers run directly via Node's native TS type-stripping
# - adapters use TS parameter properties, so they are precompiled with tsc first
set -e
cd "$(dirname "$0")/.."

mkdir -p .programmer/tmp
BUILD_DIR="$(mktemp -d "$PWD/.programmer/tmp/test-build.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT HUP INT TERM

echo "== compiling adapters (tsc) =="
npx tsc .nuxt/types/nitro-imports.d.ts \
  server/providers/openai.ts server/providers/openai-responses.ts server/providers/manager.ts server/providers/claude.ts server/providers/gemini.ts server/providers/codex.ts \
  server/providers/claude-subscription.ts server/providers/antigravity.ts server/providers/loader.ts \
  server/core/registry.ts server/core/protocol-registry.ts server/core/hooks.ts server/core/builtin-hooks.ts server/core/pipeline.ts \
  server/providers/builtins.ts server/providers/model-discovery.ts server/protocols/builtins.ts \
  server/services/antigravity-token-manager.ts server/services/subscription-usage.ts server/services/thinking-policy.ts server/services/model-token-billing.ts \
  server/stores/provider.store.ts server/stores/thinking.store.ts server/stores/model-token-ratios.store.ts \
  server/utils/codex-auth.ts server/utils/claude-auth.ts server/utils/antigravity-auth.ts \
  server/protocols/gemini-generate.ts server/protocols/gemini-generate-serializer.ts \
  server/plugins-runtime/manager.ts server/plugins-runtime/manifest.ts \
  --rootDir . --outDir "$BUILD_DIR" \
  --module commonjs --target es2022 --moduleResolution node \
  --esModuleInterop --skipLibCheck --rewriteRelativeImportExtensions

printf '%s\n' '{"type":"commonjs"}' > "$BUILD_DIR/package.json"

FAIL=0
for t in tests/*.test.ts; do
  echo ""
  echo "== $t =="
  ADAPTER_BUILD="$BUILD_DIR/server" node "$t" || FAIL=1
done

echo ""
if [ "$FAIL" = "1" ]; then
  echo "RESULT: FAILED"
  exit 1
fi
echo "RESULT: ALL PASSED"
