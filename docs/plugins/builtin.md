# Built-in plugins

Most of LLMHub is itself made of plugins. The client endpoints, the upstream
providers, and policies such as quotas and rate limiting all live in
`builtin/<id>/` and register through the same `setup(api)` contract as
[runtime plugins](reference.md). This page is for people changing LLMHub
itself.

## What stays in the core

`server/` holds only what every plugin relies on:

- the unified request and response types (`server/core/types.ts`);
- the provider, protocol, ingress and hook registries (`server/core/`);
- the request pipeline that runs hooks and calls upstreams
  (`server/core/pipeline.ts`);
- the plugin manager (`server/plugins-runtime/`);
- storage, admin login and sessions, and identifying which API key a request
  carries.

**The core never imports a built-in plugin and never names a specific
protocol, upstream or policy.** If you find yourself adding
`if (protocol === 'something')` under `server/`, the behaviour belongs in a
plugin and the core needs an extension point instead.

## The built-in plugins

| Kind | Plugins | Owns |
| --- | --- | --- |
| Ingress | `ingress-openai`, `ingress-claude`, `ingress-gemini` | Client endpoints, parsers, serializers, stream framing, how a key and model are read from a request |
| Provider | `provider-openai`, `provider-claude`, `provider-gemini`, `provider-codex`, `provider-claude-subscription`, `provider-antigravity` | Adapters, model discovery, login flows, token refresh, subscription usage |
| Policy | `rate-limit`, `fallback`, `access-control`, `quota`, `token-billing`, `thinking-policy`, `cch-normalization`, `stats` | Admission checks, request rewriting, accounting, and their settings |

`builtin/shared/` holds code used by more than one plugin.

## How built-ins differ from runtime plugins

| | Built-in | Runtime |
| --- | --- | --- |
| Shipped | Compiled into the gateway | Installed while running |
| Can be disabled or removed | No | Yes |
| May import gateway internals | Yes | No, only the injected API |
| Registered IDs | Used as given (`openai`) | Prefixed (`my-plugin:echo`) |
| Public endpoints and pages | Yes, as a Nuxt layer | No public endpoints; pages only as sandboxed panels |
| Dashboard UI | Vue components, built in | Declared in the manifest |
| Version | LLMHub's version | Its own |

Built-in provider type IDs are stored in users' data (`openai`, `claude`,
`gemini`, `codex-subscription`, `claude-subscription`,
`antigravity-subscription`; see `builtin/provider-ids.ts`). Never change them.
The same goes for the six codec IDs (`openai-chat`, `openai-completion`,
`openai-responses`, `claude-messages`, `claude-completion`,
`gemini-generate`), which hooks see as `incomingProtocol`.

## Anatomy of a built-in plugin

```text
builtin/my-policy/
  nuxt.config.ts          # makes the folder a Nuxt layer
  plugin.ts               # export default { setup(api) { ... } }
  service.ts              # logic
  store.ts                # storage access
  server/api/hub/...      # management endpoints (file-based routes)
  components/             # dashboard components
  pages/                  # whole dashboard pages
  dashboard-*.ts          # where its components appear
```

Only `plugin.ts` is required, plus `nuxt.config.ts` if the plugin has routes,
pages or components.

## Adding one

1. **Create the folder** with `plugin.ts`. If it needs routes or UI, add
   `nuxt.config.ts` containing `export default defineNuxtConfig({})`. Layers
   are discovered by scanning `builtin/*/nuxt.config.ts`.
2. **Register it** in `builtin/catalog.ts`: import the plugin and add an
   `entry(...)` line, listing any built-ins it depends on. The catalog is the
   single list of what runs on the server. It is never imported by
   `nuxt.config.ts` or by browser code.
3. **Write `setup(api)`** using the same API as runtime plugins.

Built-ins may import each other directly where there is a real dependency
(Codex reuses the OpenAI Responses codec; the Claude subscription adapter
extends the Claude adapter). Declare those dependencies in the catalog so load
order is checked.

Storage for a new built-in goes under `builtin-plugins:<id>:storage:` via
`api.storage`. The existing policies keep their original storage keys, because
those hold users' data.

## Extension points you can use

Everything in the [reference](reference.md) applies. Two things are available
only to built-ins.

### Public endpoints

A file under `builtin/<id>/server/api/` is a normal Nitro route. The ingress
plugins use this for the client endpoints and register an `IngressDefinition`
so that the shared admission middleware (`server/middleware/ingress-auth.ts`)
knows how to authenticate requests under their path prefix.

### Dashboard components

Built-ins contribute real Vue components. Each page asks for contributions
through a composable in `composables/`, which collects
`builtin/*/dashboard-*.ts` at build time. The contracts are in
`shared/dashboard/`.

| File in your plugin | Contributes to | Contract |
| --- | --- | --- |
| `dashboard-navigation.ts` | The top navigation | `DashboardNavigationItem[]`: `label`, `to`, `order` |
| `dashboard-home.ts` | The home page: metric cards, the key-usage card, endpoint rows, header actions | `DashboardHomeContribution` |
| `dashboard-provider.ts` | The provider list and editor, for one provider type: form, badges, actions, details, login flow | `DashboardProviderExtension` |
| `dashboard-provider-section.ts` | Advanced settings shared by all provider types | `DashboardProviderSection` |
| `dashboard-api-key.ts` | The API key list and editor: badge, summary, meter, details, editor sections | `ApiKeyDashboardExtension` |
| `dashboard-sections.ts` | Named slots on the Models and Security pages | `DashboardSectionExtension` |
| `pages/*.vue` | A whole page | Nuxt file routing |

`builtin/token-billing/` is a small complete example: it adds three inputs to
every row of the Models page through `dashboard-sections.ts`, with its own
endpoints for saving them.

Guidelines:

- **Keep state in the session your `create()` returns**, not in module-level
  variables. A session lasts as long as the page is open.
- **A page must not name your plugin.** If it would have to, add a slot.
- **A page with no contributions must look complete.** No empty sections or
  stray dividers.

### Shared UI components

Use these rather than writing your own headers, spinners and empty states.
Pages use `<UContainer class="py-8 max-w-5xl">`.

| Component | Use for |
| --- | --- |
| `PageHeader` | Page title, description and actions |
| `PageLoading` | The page-level spinner |
| `EmptyState` | "Nothing here yet", with an optional action |
| `StatCard` | A metric on the home page |
| `SettingsCard` | A group of settings with a title, description, optional toggle and a footer for the save button |
| `EndpointRow` | A client endpoint on the home page |
| `PluginSchemaForm` | A form rendered from [field](reference.md#fields) declarations |

## Request completion

`stats` and `quota` register the public `onComplete` hook. Each admitted
generation or embedding request produces one completion, with the final model,
last reported usage and any error. Completion persistence runs in the background;
errors are logged without changing the response. Missing usage still counts one
call but does not add tokens.

`token-billing` provides its token conversion function through `api.provide`.
`quota` declares it as a required dependency and obtains the interface through
`api.require`; setup fails if the service is unavailable. No hook priority or
shared event mutation is used to transfer billed tokens.

## Testing

Run all four before committing, in this order:

```sh
npx vue-tsc --noEmit
npm test
npm run build
npm run test:e2e
```

`npm run test:e2e` only builds when `.output` is missing, so run the build
first or it tests a stale build. It also refuses to run if
`.data/plugins/example-*` exist, to avoid overwriting them.

Things specific to plugin work:

- **Tests run outside Nitro.** Anything that uses the shared registries must
  first `await initializeBuiltinPlugins()` from `builtin/assembly.ts`. Tests
  can instead build a `BuiltinPluginHost` with their own registries and
  storage.
- **`tests/run-all.sh` lists the files it precompiles.** Add new server
  modules that tests import.
- **Behaviour of the admission pipeline is pinned** by
  `tests/*-characterization.test.ts`: status codes, error bodies, and the
  order of checks for each client protocol. If one fails, you changed
  something clients can observe.
- **`tests/plugin-api.type-test.ts` fails if `llmhub-plugin.d.ts` drifts** from
  the real types. Update the declarations when you change the plugin API.
- **Dashboard markup has no automated check.** `tests/dashboard-behavior.test.mjs`
  covers page logic only. Look at UI changes in a browser, in both themes and
  at phone width.

## Changing the plugin API

The API that runtime plugins see is a public contract with its own version
(`PLUGIN_API_VERSION` in `server/core/plugin-version.ts`).

1. Decide the version bump using the rules in
   [Versioning](reference.md#versioning).
2. Update `examples/plugins/llmhub-plugin.d.ts`.
3. Add an entry to the [changelog](changelog.md).
4. Update the [reference](reference.md).

Adding a hook stage or an optional field is a minor bump. Anything that could
break an existing plugin is a major bump, and should be rare.
