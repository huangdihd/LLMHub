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
- `server/api/`: core dashboard management APIs under `hub/`. Client-compatible routes live in `builtin/ingress-*/server/api/`, preserving their public URLs.
- `builtin/ingress-{openai,claude,gemini}/`: client parsers, serializers, stream framing, embedding helpers and admission definitions. `server/core/{protocol,ingress}-registry.ts` retain only generic registration and lookup; `server/protocols/` is no longer used.
- `server/providers/`: generic registry-based provider loading/routing. Concrete adapters operate on unified types in `server/core/types.ts` and live under `builtin/provider-*/`.
- `server/services/`: shared service contracts and registry-dispatched subscription usage/reset. Provider login/token flows and policy services live with their built-in plugins.
- `builtin/<id>/`: always-on ingress/provider/policy plugins and optional Nuxt layers, including management routes and storage access. Provider directories are `provider-openai`, `provider-claude`, `provider-gemini`, `provider-codex`, `provider-claude-subscription`, and `provider-antigravity`. `builtin/catalog.ts` is the runtime registration list; root Nuxt configuration scans `builtin/*/nuxt.config.ts` without importing the catalog. `builtin/assembly.ts` is the non-Nitro composition entry: await `initializeBuiltinPlugins()` before using shared registries; provide `useStorage` when exercising persisted operations. Core registries, hooks, pipeline and middleware must not import concrete built-in plugins.
- Built-in providers share implementation dependencies: Codex uses the OpenAI Responses codec, Claude subscription extends Claude, Antigravity uses Gemini conversion, and subscription helpers live in `builtin/shared/`. Ingress Responses/Gemini modules import provider-owned thinking-state/schema helpers; structured-output conversion and common ingress admission helpers live in `builtin/shared/`. Built-ins are not independent packages.
- `server/stores/`: Nitro-storage-backed persistence. Keep credentials inside `ProviderConfig.connection` and sanitize them from management API responses. Thinking policy settings are stored under `settings:thinking`; per-model input/output/cached token billing ratios are stored under `settings:model-token-ratios`.
- `server/middleware/`: authentication for dashboard and compatible API endpoints.
- `server/utils/`: generic error, networking, authentication and URL-safety helpers; protocol-specific utilities belong to built-ins.
- `tests/`: native Node TypeScript protocol/adapter tests; `tests/e2e/` uses mock upstream recordings and official SDKs.
- `references/`: vendored upstream SDK source used as protocol reference material. It is excluded from project TypeScript checks; do not edit it for LLMHub behavior.

## Conventions and Durable Gotchas

- Add protocol-independent behavior to the unified request/response types instead of coupling ingress routes directly to an upstream format.
- Unified messages support `developer`. Responses ingress preserves developer messages and their order; Responses and Codex egress retain that role in `input`, rather than moving it into `instructions` or coercing it to `user`. System items and explicit instructions keep their existing normalization. No new fallback for upstreams without developer support is defined.
- Upstream providers register `ProviderDefinition` from `server/core/registry.ts` via built-in/runtime `setup(api)`; `ProviderManager` and `ProviderLoader` dispatch through the registry. Built-in registration preserves persisted protocol IDs (`openai`, `claude`, `gemini`, `codex-subscription`, `claude-subscription`, `antigravity-subscription`); runtime IDs remain namespaced. `ProviderConfig.protocol` is an extensible string; unknown protocols are logged and skipped. Client parser/serializer factories register separately through `server/core/protocol-registry.ts`. See `docs/plugins.md` for the current provider contract.
- Optional provider management and subscription usage/reset capabilities are shared with runtime plugins. `refreshAccessToken` and `login.path` are currently declarations without generic host dispatch: built-ins invoke token managers directly and own login routes. Do not assume declaring either capability wires runtime login/refresh; provider-type API responses expose ID, display name and connection schema only.
- Runtime plugins live in `.data/plugins/<id>/` and load through `server/plugins-runtime/` at startup (`server/plugins/runtime-plugins.ts`) or through `/api/hub/plugins`. They are trusted in-process ESM code, not sandboxed; native dynamic import must remain outside Rollup's bundle graph. Lifecycle registrations are namespaced and revoked on disable. State/storage keys use `runtime-plugins:` to avoid collision with plugin files. See `docs/plugins.md` for the author API and limitations.
- `/plugins` lists built-in ingress, providers and policies read-only alongside runtime plugin installation/configuration; `components/PluginSchemaForm.vue` also renders plugin provider connection fields under `connection.extra`. `/api/hub/provider-types` exposes live schemas. Preserve built-in provider forms and login flows; unknown/unloaded plugin protocols remain stored but unavailable. Tests: `tests/plugins.test.ts`, `tests/plugin-provider.test.ts`, and `tests/e2e/plugins.test.mjs`.
- Ingress and protocol definitions register through the same `PluginAPI` as providers/hooks; built-ins retain original IDs, runtime registrations use `<pluginId>:<localId>`. Ingress prefix matching preserves first-registration raw `startsWith` semantics. `rewriteBeforeRejection` preserves body versus URL model replacement order. Runtime registration does not create Nitro routes or a generic public generation dispatcher. Managers snapshot codecs at construction, so await builtin assembly first; serializer lookup uses the registered ID, not necessarily the parser's local name.
- Six generation ingress routes use `server/core/pipeline.ts` for request hooks, upstream calls and SSE decoding; protocol framing remains in each route. `server/core/hooks.ts` orders hooks by ascending priority, with stable registration order for ties. Admission, model catalog, normalization and request-hook failures propagate; response/stream/lifecycle failures are logged and processing continues. `onAccountingComplete` preserves each route's original attempt/usage and await boundaries. See `docs/plugins.md` for policy stages and `docs/request-pipeline.md` for generation framing.
- LLMHub targets LLM/VLM requests, not image generation. Antigravity uses agent request envelopes; client request mode selects `generateContent` for non-stream or `streamGenerateContent` for stream, never model names or automatic mode fallback; preserve visual inputs and tool-result images when changing its request wrapping. Output limits and structured-output parameters follow Gemini conversion without model-name filtering; tests verify local forwarding, not real upstream acceptance or schema enforcement.
- Antigravity Google One AI Credits are paid and explicit opt-in via `connection.use_ai_credits_on_quota_exhausted`. Send the normal request first; only a 429 body explicitly containing `QUOTA_EXHAUSTED` or `quota exhausted` may trigger one retry with top-level `enabledCreditTypes: ["GOOGLE_ONE_AI"]`. Rate limits, capacity failures, and unknown 429s must never consume credits.
- Structured output is normalized in `GenerateConfig.outputFormat` via `builtin/shared/structured-output.ts`. Preserve schema dialect and explicit strictness; incompatible conversions fail with 400 rather than dropping constraints. Responses serializers receive request format for sync and stream metadata. Model enforcement remains upstream.
- Responses signed thinking uses a versioned `llmhub:thinking:v1:` envelope in `encrypted_content`, preserving original text and signatures for gateway replay. This is encoding, not encryption. Native OpenAI opaque state passes unchanged; invalid gateway envelopes fail with 400. The Responses stream route must forward signature-only chunks.
- Gemini/Antigravity thinking signatures must survive sync responses, signature-only stream parts, Antigravity SSE unwrapping, and signed history replay. Emit text and signature as separate unified stream chunks for Claude serialization. Already unsigned client history cannot recover lost signatures.
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
