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
- `server/services/`: stateful authentication and token-management flows for subscription providers.
- `server/stores/`: Nitro-storage-backed persistence. Keep credentials inside `ProviderConfig.connection` and sanitize them from management API responses.
- `server/middleware/`: authentication for dashboard and compatible API endpoints.
- `server/utils/`: shared request, error, authentication, embedding, and schema helpers.
- `tests/`: native Node TypeScript protocol/adapter tests; `tests/e2e/` uses mock upstream recordings and official SDKs.
- `references/`: vendored upstream SDK source used as protocol reference material. It is excluded from project TypeScript checks; do not edit it for LLMHub behavior.

## Conventions and Durable Gotchas

- Add protocol-independent behavior to the unified request/response types instead of coupling ingress routes directly to an upstream format.
- A new upstream protocol normally requires a provider adapter, registration in `ProviderManager`, model loading in `ProviderLoader`, persisted and sanitized config support, dashboard support, and tests.
- Preserve streaming and non-streaming behavior across compatible ingress protocols. Tool calls, thinking blocks, finish reasons, and usage are normalized before serialization.
- Stored provider names are immutable and become the prefix in public model IDs.
- Provider model results are cached in memory for five minutes; configuration changes must invalidate `ProviderLoader`'s cache.
- Subscription refresh tokens, access tokens, account identifiers, and installation/device identifiers are server-side secrets and must never be returned by hub APIs. Subscription plan/quota details are fetched server-side, normalized, and cached briefly; upstreams may omit plan metadata.
- `tests/run-all.sh` explicitly lists provider and utility files that need precompilation; update it when tests import a new adapter using TypeScript syntax unsupported by Node type stripping.
- E2E tests modify `.data/`, start local processes, and restore seeded state through their cleanup trap. They may rebuild `.output/`.
- There is no configured standalone linter. Type checking is the available continuous diagnostic checker.
