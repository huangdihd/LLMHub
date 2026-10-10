#!/bin/sh
# Runs all protocol tests. No test framework needed:
# - parsers/serializers run directly via Node's native TS type-stripping
# - adapters use TS parameter properties, so they are precompiled with tsc first
set -e
cd "$(dirname "$0")/.."

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llmhub-test-build.XXXXXX")"
# Resolve compiled CommonJS dependencies without node_modules symlink loops.
export NODE_PATH="$PWD/node_modules${NODE_PATH:+:$NODE_PATH}"
trap 'rm -rf "$BUILD_DIR"' EXIT HUP INT TERM

echo "== compiling adapters (tsc) =="
npx tsc .nuxt/types/nitro-imports.d.ts \
  server/providers/manager.ts server/providers/loader.ts \
  server/core/registry.ts server/core/protocol-registry.ts server/core/hooks.ts server/core/pipeline.ts \
  server/protocols/builtins.ts server/services/subscription-usage.ts \
  server/stores/provider.store.ts builtin/assembly.ts builtin/*/plugin.ts \
  server/middleware/ingress-auth.ts server/protocols/admission.ts \
  server/protocols/gemini-generate.ts server/protocols/gemini-generate-serializer.ts \
  server/plugins-runtime/manager.ts server/plugins-runtime/manifest.ts \
  --rootDir . --outDir "$BUILD_DIR" \
  --module commonjs --target es2022 --moduleResolution node \
  --esModuleInterop --skipLibCheck --rewriteRelativeImportExtensions

printf '%s\n' '{"type":"commonjs"}' > "$BUILD_DIR/package.json"

# Match Nitro startup before tests use the shared provider registry.
cat > "$BUILD_DIR/run-test.mjs" <<'EOF'
import { pathToFileURL } from 'node:url'
if (process.argv[2].endsWith('/antigravity-subscription.test.ts')) {
  process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = 'test-antigravity-client-id'
  process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'test-antigravity-client-secret'
}
if (process.argv[2].endsWith('/builtin-host.test.ts')) {
  // Preserve the original eight-policy host fixture and its unchanged assertions.
  // provider-capabilities.test.ts separately exercises the complete production catalog.
  const { builtinCatalog } = await import('./builtin/catalog.js')
  const policies = builtinCatalog.filter(plugin => !plugin.manifest.id.startsWith('provider-'))
  builtinCatalog.splice(0, builtinCatalog.length, ...policies)
}
const { initializeBuiltinPlugins } = await import('./builtin/assembly.js')
await initializeBuiltinPlugins()
await import(pathToFileURL(process.argv[2]).href)
EOF

FAIL=0
for t in tests/*.test.ts; do
  echo ""
  echo "== $t =="
  ADAPTER_BUILD="$BUILD_DIR/server" node "$BUILD_DIR/run-test.mjs" "$PWD/$t" || FAIL=1
done

echo ""
if [ "$FAIL" = "1" ]; then
  echo "RESULT: FAILED"
  exit 1
fi
echo "RESULT: ALL PASSED"
