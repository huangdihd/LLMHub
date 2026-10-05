# LLMHub Project Guide

## Overview

LLMHub is a Nuxt 3 application that exposes OpenAI-, Anthropic Claude-, and Google Gemini-compatible HTTP APIs over multiple upstream LLM providers. Protocol parsers normalize incoming requests, provider adapters call the selected upstream, and protocol serializers return the client's expected format. Provider/model IDs use `provider/model` namespacing.

## Stack

- TypeScript (strict mode), Vue 3, Nuxt 3, and Nitro
- Nuxt UI with Tailwind CSS
- Nitro filesystem storage mounted as `data`; runtime state is written under `.data/`
- Node-based protocol tests and SDK-based end-to-end tests

## Commands

```sh
npm install          # install dependencies and run `nuxt prepare`
npm run dev          # development server (http://localhost:3000)
npm run build        # production Nuxt/Nitro build
npm run preview      # preview a production build
npm test             # compile selected server modules, then run tests/*.test.ts
npm run test:e2e     # build/start gateway and mock upstream, then run real-SDK tests
npm run test:record  # refresh upstream E2E recordings; requires upstream access
npx vue-tsc --noEmit # project type-check
```

## Project Boundaries

- `pages/`: Vue dashboard pages for providers, models, keys, chat, authentication, and security.
- `layouts/` and `app.vue`: application shell and navigation.
- `server/api/`: Nitro file-based routes. `hub/` serves dashboard management APIs; `openai/`, `claude/`, and `gemini/` are client-compatible ingress APIs.
- `server/protocols/`: request parsers and response/stream serializers for each client protocol.
- `server/providers/`: upstream adapters plus provider loading/routing. Adapters operate on unified types in `server/core/types.ts`.
- `server/services/`: stateful authentication/token-management flows and shared request policy resolution, including configurable thinking policies.
- `server/stores/`: Nitro-storage-backed persistence. Keep credentials inside `ProviderConfig.connection` and sanitize them from management API responses. Thinking policy settings are stored under `settings:thinking`; per-model input/output/cached token billing ratios are stored under `settings:model-token-ratios`.
- `server/middleware/`: authentication for dashboard and compatible API endpoints.
- `server/utils/`: shared request, error, authentication, embedding, and schema helpers.
- `tests/`: native Node TypeScript protocol/adapter tests; `tests/e2e/` uses mock upstream recordings and official SDKs.
- `references/`: vendored upstream SDK source used as protocol reference material. It is excluded from project TypeScript checks; do not edit it for LLMHub behavior.

## Conventions and Durable Gotchas

- Add protocol-independent behavior to the unified request/response types instead of coupling ingress routes directly to an upstream format.
- Unified messages support `developer`. Responses ingress preserves developer messages and their order; Responses and Codex egress retain that role in `input`, rather than moving it into `instructions` or coercing it to `user`. System items and explicit instructions keep their existing normalization. No new fallback for upstreams without developer support is defined.
- A new upstream protocol normally requires a provider adapter, registration in `ProviderManager`, model loading in `ProviderLoader`, persisted and sanitized config support, dashboard support, and tests.
- Structured output is normalized in `GenerateConfig.outputFormat` via `server/utils/structured-output.ts`. Preserve schema dialect and explicit strictness; incompatible conversions fail with 400 rather than dropping constraints. Responses serializers receive request format for sync and stream metadata. Model enforcement remains upstream.
- Responses signed thinking uses a versioned `llmhub:thinking:v1:` envelope in `encrypted_content`, preserving original text and signatures for gateway replay. This is encoding, not encryption. Native OpenAI opaque state passes unchanged; invalid gateway envelopes fail with 400. The Responses stream route must forward signature-only chunks.
- Gemini/Antigravity thinking signatures must survive sync responses, signature-only stream parts, Antigravity SSE collection, and signed history replay. Emit text and signature as separate unified stream chunks for Claude serialization. Already unsigned client history cannot recover lost signatures.
- Gemini/Antigravity history must preserve `meta.toolCalls[].id` as `functionCall.id`, matching `functionResponse.id`, including failed tool results. Responses tool replay coverage lives in `tests/responses-thinking-state.test.ts`.
- Gemini/Antigravity tool schemas normalize single-type and nullable JSON Schema type arrays through `sanitizeGeminiSchema`; multi-non-null, null-only, and invalid type arrays fail locally with 400 instead of being narrowed. This helper is also used by Gemini ingress.
- Preserve streaming and non-streaming behavior across compatible ingress protocols. Tool calls, thinking blocks, finish reasons, and usage are normalized before serialization.
- Visible Responses reasoning uses `reasoningKind: 'raw' | 'summary'` on thinking blocks/chunks; raw maps to `reasoning_text`, summary to `summary_text`. Unmarked legacy adapters retain summary output. This is separate from opaque/encrypted reasoning; upstream request serialization is unchanged.
- OpenAI, Claude, and Gemini adapters use the full provider connection timeout for each upstream stream read, independently of the response-header timeout. Each read resets the idle deadline; disabling timeouts disables both timers.
- OpenAI upstream selection is stored in `connection.api_type` (`responses` or `chat_completions`), independently of ingress protocol. Newly created OpenAI providers default to Responses; missing legacy values retain Chat Completions. Do not silently fall back between APIs.
- Stored provider names are immutable and become the prefix in public model IDs.
- Provider model results are cached in memory for five minutes. Expired entries are returned stale while one background refresh runs; configuration changes invalidate the cache so the next request waits for fresh data. Upstream model discovery uses a fixed 10-second timeout with one retry.
- Subscription refresh tokens, access tokens, account identifiers, and installation/device identifiers are server-side secrets and must never be returned by hub APIs. Subscription plan/quota details are fetched server-side, normalized, and cached briefly; upstreams may omit plan metadata.
- Runtime helper imports in native-Node parser tests use `.ts` extensions; project type checking allows them and test precompilation uses `--rewriteRelativeImportExtensions`.
- `tests/run-all.sh` explicitly lists provider and utility files that need precompilation; update it when tests import a new adapter using TypeScript syntax unsupported by Node type stripping.
- E2E tests modify `.data/`, start local processes, and restore seeded state through their cleanup trap. They may rebuild `.output/`.
- There is no configured standalone linter. Type checking is the available continuous diagnostic checker.

- Gemini tool signature placeholders are injected only when the current assistant message has no real thinking/tool signature. Never select this behavior by model name or borrow a signature from a previous turn.
