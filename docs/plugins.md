# Writing runtime plugins

Runtime plugins add upstream provider types, generation hooks, management routes,
and optional dashboard pages without rebuilding or restarting LLMHub. Start with
`examples/plugins/echo.mjs` (a network-free streaming provider) or
`examples/plugins/system-prompt.mjs` (a configurable request hook).

## Trust model

**Install only code you trust.** Plugins execute inside the gateway process with
its full Node.js and filesystem permissions. This is not a sandbox. Manifests are
validated before execution; installation and activation remain code-execution
trust decisions, not merely metadata operations. Plugins must not import gateway
build internals. Use the injected API, Node built-ins, shipped files, and npm
library dependencies. npm installation disables lifecycle scripts, but that does
not make package code safe when imported. Dashboard authentication protects management endpoints, but does not
make an untrusted plugin safe. Hook contexts and provider configurations contain
credentials: do not log or return them.

## Files and manifest

The filesystem layout is relative to the gateway process's working directory,
matching Nitro's `data` storage at `./.data`:

```text
.data/plugins/my-plugin/
  plugin.json
  index.mjs
  ui/index.html       # optional
  ui/main.js          # optional
```

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Example plugin",
  "entry": "index.mjs",
  "configSchema": [
    { "key": "instruction", "label": "Instruction", "type": "text", "default": "Be concise" },
    { "key": "token", "label": "API token", "type": "secret" }
  ],
  "ui": { "page": "ui/index.html" }
}
```

`id`, `name`, and `version` are required. IDs match
`^[a-z0-9][a-z0-9-]{1,40}$` and must equal the directory name. `entry` defaults to
`index.mjs`; legacy entries remain `.mjs` files. Paths are relative to the plugin directory;
absolute paths, traversal, encoded path components, backslashes, and symlinks are
rejected. Place multi-file plugins there and use **Scan plugins**. Existing
plugins are updated with **Reload**, not Scan.

For single-file upload (maximum **1 MiB**), export the same object as
`export const manifest = { ... }` alongside the default export. The installer
writes `plugin.json` and `index.mjs`; external files and custom pages must be
installed as a directory instead.

### Field declarations

Both `configSchema` and provider `connectionSchema` use this shape:

```ts
interface PluginField {
  key: string
  label?: string
  type: 'text' | 'secret' | 'number' | 'boolean' | 'select'
  required?: boolean
  default?: string | number | boolean
  options?: { label: string; value: string | number | boolean }[]
}
```

Keys are unique identifiers matching `[a-zA-Z][a-zA-Z0-9_]*`; prototype-related
keys are rejected. Schemas allow at most 100 fields. Selects require options;
secret defaults are forbidden. Values are validated without string-to-number or
string-to-boolean coercion. Unknown fields are rejected. Configure required fields
before enabling a plugin. Configuration responses omit secrets. Omitted, empty,
or masked (`********`) secret updates preserve the previous value; `null` clears
an optional secret. Credentials remain plaintext in local Nitro storage: secure
and back up `.data` accordingly.

## npm package format and installation

`package.json` is the preferred manifest. When both manifests exist it wins;
`plugin.json` remains read-only compatible, with no migration of existing state.
For example:

```json
{
  "name": "@example/llmhub-plugin-text-service",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": { "import": "./index.js" } },
  "description": "A text service",
  "keywords": ["llmhub-plugin"],
  "engines": { "llmhub": "^1.0.0" },
  "dependencies": { "tiny-library": "^1.0.0" },
  "llmhub": {
    "id": "text-service",
    "name": "Text service",
    "configSchema": [],
    "ui": { "page": "ui/index.html" },
    "dependencies": { "provider-openai": "^1.0.0" },
    "optionalDependencies": { "audit-service": "^1.0.0" }
  }
}
```

- npm `name` and valid semver `version` are required. `description` and
  `engines.llmhub` retain their usual meanings; the latter targets the plugin API.
- `exports` selects the package root's Node import/default target (including
  conditional exports); otherwise `main`, then `index.mjs`, is used. Entry files
  must be shipped JavaScript (`.mjs`, `.js`, or `.cjs`); `type` has Node's normal
  ESM/CommonJS meaning. TypeScript/build sources alone are not loadable.
- `llmhub` is required to identify a package as a plugin. `llmhub.id` defaults to
  the unscoped package name with `llmhub-plugin-` removed. The result must satisfy
  the existing ID rule and must not collide with built-ins or another plugin.
  `llmhub.name` is the display name, defaulting to npm `name`.
- `llmhub.configSchema`, `llmhub.ui`, `llmhub.dependencies`, and
  `llmhub.optionalDependencies` correspond to the legacy top-level fields.
  `configSchema` and UI path validation are unchanged.
- Top-level npm `dependencies`/`peerDependencies` name **packages**. When an
  installed package has `llmhub` metadata, it is also inferred as a plugin-ID
  dependency using the npm range. Ordinary libraries never enter the plugin
  lifecycle graph. Optional npm dependencies/optional peers remain optional.
  Explicit plugin-ID declarations also allow depending on built-ins.
- `keywords: ["llmhub-plugin"]` makes published packages discoverable in the
  market. README, repository, homepage, author and other npm metadata remain npm
  metadata, not executable dashboard content.

Single-file literal `export const manifest` accepts both shapes. Its server
upload endpoint remains compatible for scripts/tests; the new installation
workflow is package/GitHub installation. No dashboard controls are changed in
this release. `examples/plugins/package-service/` is a publishable directory
example; offline tests provide a tiny library package with no transitive dependencies.

`.data/plugins/` is a private npm project with its own `package.json`,
`package-lock.json`, and `node_modules/`. Scan discovers `llmhub` packages,
including nested transitive packages, as well as existing manual directories.
Manual directory names still equal plugin IDs and can import libraries installed
in this project. npm resolves libraries; the gateway resolves plugin lifecycle
and exports. New installations remain disabled until configured and enabled.
Invalid metadata/API compatibility is reported without importing the plugin.

Install operations invoke system npm with argument arrays, never shell strings:
`--ignore-scripts --omit=dev --no-audit --no-fund --package-lock=true`.
Inputs are separate validated npm name/version fields or GitHub owner/repo/ref
fields (or a parsed `https://github.com/owner/repo[.git][/tree/ref]` URL).
Other hosts, arbitrary git URLs, local paths, tarballs, aliases, leading options,
whitespace and executable punctuation are rejected. Versions accept semver
ranges, not dist-tags such as `latest`; omission uses npm's default range.
Package contents and their transitive dependencies are still trusted executable
code: this validation is not a supply-chain sandbox or a substitute for review.

Runtime deployment needs **npm on PATH** and registry access; GitHub installation
also needs **git on PATH**. Missing tools/connectivity report operation-level
errors and do not prevent gateway startup, local plugins, or uploads. GitHub
`prepare`/build scripts do not run: the selected ref must contain a committed,
loadable entry file. Private repositories have no dedicated support; operators
may configure server-side git credentials. Registry defaults to
`https://registry.npmjs.org/`, is persisted separately from plugin state, and can
be set to a mirror/private registry. Configure authentication in server npm
configuration; the API neither accepts nor exposes registry tokens.

Mutations share the plugin manager queue. npm builds a replacement project in a
system temporary directory before changing live files. Validation, activation,
or persistence failure restores project/lock/library files and plugin state;
incomplete rollback explicitly reports retained recovery files. Updates preserve
configuration, storage and enabled state, and restart enabled package plugins
and their consumers in dependency order. Unrelated local plugins stay live.
Uninstall refuses enabled required consumers; transitive packages must be removed
through their owning package. Successful removal clears plugin configuration and
storage. npm sources retain name/range; GitHub sources retain owner/repo/ref and
resolved commit. External side effects from trusted plugin code cannot be undone.

## Entry point and injected API

```js
export default {
  async setup(api) {
    api.registerHook({
      id: 'instruction',
      onRequest(request) {
        return {
          ...request,
          config: { ...request.config, systemPrompt: api.config.instruction }
        }
      }
    })
    api.registerRoute('GET', 'status', () => ({ ready: true }))
    return async () => {
      // Stop timers, close connections, and release your own resources.
    }
  }
}
```

The runtime API's complete public surface is:

```ts
type Awaitable<T> = T | Promise<T>
type Cleanup = () => Awaitable<void>

interface PluginAPI {
  readonly config: Readonly<Record<string, unknown>>
  registerProvider(definition: ProviderDefinition): void
  registerProtocol(definition: ProtocolDefinition): void
  registerIngress(definition: IngressDefinition): void
  registerHook(hook: RequestHook): void
  registerRoute(method: string, path: string,
    handler: (event: H3Event) => Awaitable<unknown>): void
  onConfigChange(listener:
    (configuration: Readonly<Record<string, unknown>>) => Awaitable<void>): void
  storage: {
    getItem<T>(key: string): Promise<T | null>
    setItem<T>(key: string, value: T): Promise<unknown>
    removeItem(key: string): Promise<unknown>
  }
  logger: Pick<Console, 'info' | 'warn' | 'error'>
}

// Default export:
interface PluginModule {
  setup(api: PluginAPI): Awaitable<void | Cleanup>
}
```

These TypeScript names describe structural contracts, not runtime imports.
Gateway types live in `server/core/types.ts`, `server/core/registry.ts`, and
`server/core/hooks.ts`; the authoritative injected signature is in
`server/plugins-runtime/manager.ts`. No extra `types` runtime helper is currently
needed or exposed; throw ordinary `Error` objects for failures.

Register providers, protocols, ingress definitions, hooks, routes, and config listeners during `setup`, including
its awaited work. Registration closes when setup finishes or times out. Supply
**local** provider/protocol/ingress/hook IDs matching `[a-z0-9][a-z0-9-]{0,63}`: the loader always
prepends `<pluginId>:`. Passing a pre-prefixed ID is invalid. Duplicate
registrations fail rather than replacing other plugins or built-ins.

`config` returns a fresh read-only snapshot of the current configuration. Read it
when handling requests, or subscribe to `onConfigChange`. Updates persist before
callbacks run; callback failure disables the runtime rather than leaving partially
updated registrations active. Storage keys contain alphanumerics, `_`, `-`, and
optional `/`-separated components. Storage is isolated by plugin ID under
`runtime-plugins:<id>:storage:`, separate from plugin files. State is stored under
`runtime-plugins:<id>:state`. Storage access is rejected after deactivation.
Log methods prepend the plugin ID; plugins are responsible for avoiding secrets
in their own log messages.

### Providers

```ts
interface ProviderDefinition {
  id: string
  displayName?: string
  connectionSchema?: PluginField[]
  management?: ProviderManagement
  createAdapter(configuration: ProviderConfig): ProviderAdapter
  fetchModels(configuration: ProviderConfig,
    context: { fetcher(url: string, options?: RequestInit): Promise<Response> }
  ): Promise<ModelInfo[]>
  secretConnectionFields: readonly string[]
  requiresRefreshToken?: boolean
  refreshAccessToken?(configuration: ProviderConfig): Promise<ProviderConfig>
  subscriptionUsage?(configuration: ProviderConfig, fetcher: typeof fetch): Promise<SubscriptionUsage>
  resetSubscriptionUsage?(configuration: ProviderConfig, creditId: string | undefined,
    idempotencyKey: string, fetcher: typeof fetch): Promise<SubscriptionResetResult>
  login?: { path: string }
}

interface ProviderManagement {
  acceptsExtra?: boolean
  flatCreateCredentials?: boolean
  creationError?: string
  protectedConnectionFields?: readonly string[]
  flatConnectionFields?: Readonly<Record<string, (value: unknown) => unknown>>
  createConnectionDefaults?: Partial<ProviderConfig['connection']>
}

interface ProviderAdapter {
  name: string
  toProviderRequest(request: LLMRequest): any
  call(request: any): Promise<any>
  callStream(request: any): ReadableStream | Promise<ReadableStream>
  fromProviderResponse(response: any): LLMResponse
  fromProviderStreamChunk(chunk: any, state?: any): LLMStreamChunk | LLMStreamChunk[]
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>
  getModels(): ModelInfo[]
}
```

Connection form values live in `configuration.connection.extra`. Secret schema
fields are automatically added as `extra.<key>` sanitization paths; use
`secretConnectionFields: []` if no additional secret paths are needed. Management
responses must not contain those credentials, including when the plugin is
unloaded. Create/update operations require a currently registered protocol and
validate the plugin connection schema. Disabling/uninstalling a plugin does not
delete provider configurations: they become unavailable and are safely skipped.
Built-in provider configuration and login URLs retain their existing contracts.

These optional capabilities belong to the shared `ProviderDefinition` in
`server/core/registry.ts`, not a built-in-only API: runtime registration preserves
these fields too. `management` controls schema acceptance, legacy flat credential
creation, creation restrictions, protected update fields, field normalization,
and creation defaults. `protectedConnectionFields` applies to both flat and nested
updates. `createConnectionDefaults` fills only fields still absent after common
storage normalization; it does not override common timeout/credential defaults.
Subscription usage/reset dispatch through registry
callbacks; their result types live in `server/services/subscription-usage.ts`.
`requiresRefreshToken` affects sanitized authentication status. Currently
`refreshAccessToken` and `login.path` are declarations, not generic host-dispatched
flows: built-in adapters/discovery call their token managers directly, and login
uses provider-owned routes and existing dashboard flows. A runtime plugin must
implement its own refresh invocation and login routes/UI; declaring these fields
alone does not wire them up.

`fetchModels` returns namespaced IDs such as `<providerName>/echo`; its helper
fetcher has a ten-second timeout and one retry. Custom model catalogs still work.
Streaming adapters supply UTF-8 SSE `data:` lines containing upstream JSON;
`fromProviderStreamChunk` converts each parsed object to unified chunks. The
pipeline recognizes `data: [DONE]`. The echo example demonstrates content, final
usage, and finish chunks without network access. See `server/core/types.ts` for
unified messages, tool calls, reasoning, embedding, and usage structures.

### Client protocols and ingress admission

```ts
interface ProtocolDefinition {
  id: string
  createParser(): ProtocolParser
  createSerializer(): ProtocolSerializer
}
interface IngressModel {
  model: string
  replace(model: string): void
}
interface IngressDefinition {
  id: string
  pathPrefix: string
  extractKey(event: H3Event): string
  missingKeyMessage: string
  extractModel(event: H3Event): IngressModel | Promise<IngressModel>
  rewriteBeforeRejection: boolean
  sendError(event: H3Event, rejection: AdmissionRejection): Awaitable<unknown>
}
```

Contracts and shared registries live in `server/core/protocol-registry.ts` and
`server/core/ingress-registry.ts`. Register codecs and admission definitions
separately during `setup`. Registration is rolled back on setup failure and
revoked on disable/reload/shutdown. Runtime IDs receive the plugin namespace;
built-ins retain their existing IDs. `PluginRecord.protocols` and `.ingresses`
report registered IDs alongside `.providers` and `.hooks`.

Ingress lookup uses first-registration **raw `startsWith(pathPrefix)`** matching,
not path-segment or longest-prefix matching. Exact duplicate prefixes are rejected;
overlapping prefixes retain registration precedence. This preserves existing
compatible-endpoint behavior, including matching suffixes immediately after the
prefix. Define narrow prefixes: admission runs before the matching route handler
and can otherwise affect unrelated management endpoints.

`extractKey` runs before POST admission hooks. Missing keys can still use the
existing dashboard session/impersonation path. `extractModel` runs after identity
and quota admission. `rewriteBeforeRejection` controls whether a resolved model
is written back even when model admission rejects: true for built-in body-based
entrypoints, false for the URL-based entrypoint. `sendError` owns status, headers
and the rejection body; it must terminate or return the response appropriately.

Codec registration order is parser precedence. Each new `ProviderManager` creates
fresh parser/serializer instances; an existing manager retains its snapshot for
its request. Serializer lookup uses the **registered protocol ID**, not necessarily
`parser.name` (runtime factory instances may retain local names). Existing in-flight
requests are not cancelled by unregistering a codec.

**Runtime limits:** these APIs register codecs and admission behavior, not Nitro
file routes. There is no generic public generation dispatcher that turns an
entry definition into a new endpoint. Runtime plugins can implement handlers via
`registerRoute` under their existing management-route namespace, subject to its
dashboard authentication, or supply definitions consumed by an already mounted
compatible handler. Registering a parser alone does not override the six built-in
routes' serializer selection or framing. Public endpoint files require a bundled
Nuxt layer and a rebuild; runtime plugins must not import gateway build internals.

### Hooks

```ts
interface RequestHook {
  id: string
  priority?: number
  onBeforeIdentity?(context: AdmissionContext): Awaitable<AdmissionRejection | void>
  onAfterIdentity?(context: AdmissionContext): Awaitable<AdmissionRejection | void>
  onModelResolved?(context: AdmissionContext): Awaitable<AdmissionRejection | void>
  onModels?(models: ModelInfo[], context: HookContext): Awaitable<ModelInfo[] | void>
  onModelsRefreshed?(validModelIds: ReadonlySet<string>): Awaitable<void>
  onNormalize?(request: LLMRequest, context: HookContext): Awaitable<LLMRequest | void>
  onAccountingComplete?(completion: AccountingCompletion, context: HookContext): Awaitable<void>
  onRequest?(request: LLMRequest, context: HookContext): Awaitable<LLMRequest | void>
  onResponse?(response: LLMResponse, context: HookContext): Awaitable<LLMResponse | void>
  onStreamChunk?(chunk: LLMStreamChunk, context: HookContext):
    Awaitable<LLMStreamChunk | LLMStreamChunk[] | null | void>
  onError?(error: unknown, context: HookContext): Awaitable<void>
  onComplete?(completion: { usage?: Usage; error?: unknown }, context: HookContext): Awaitable<void>
}
interface HookContext {
  incomingProtocol: string
  providerName?: string
  providerConfig?: ProviderConfig
  apiKeyRecord?: ApiKeyRecord
}
```

```ts
interface AdmissionRejection { status: number; message: string; code: string }
interface AdmissionContext {
  event: H3Event
  incomingProtocol: string // openai, claude, gemini
  apiKeyRecord?: ApiKeyRecord
  model: string
}
type AccountingCompletion =
  | { kind: 'attempt' }
  | { kind: 'usage'; usage: number | Usage; model?: string; tokens?: number }
```

Lower priorities run first; ties retain registration order. `undefined` preserves
the value, stream `null` or `[]` drops a chunk, and arrays expand a chunk.
Admission stops at the first returned rejection; ingress code formats its response.
POST admission runs before identity (IP rate limiting), after identity (monthly
quota), then, for a nonempty model, model resolution (fallback at -300, access
control at -200, model/provider quotas at -100). Change `context.model` to route
before parsing the unified request. GET model lists skip POST checks and run
`onModels` for filtering and fallback catalog insertion. Administrator sessions
that do not impersonate a key bypass post-identity admission; an unknown
`X-LLMHub-Key-ID` is rejected with 401 `invalid_api_key`.
These boundaries also cover embeddings; unified generation hooks do not.

`onNormalize` is a formal main-registry stage, currently called at the Claude
messages boundary after request logging. CCH normalization uses that stage;
there is no separate normalization registry. Thinking remains `onRequest`.

`onAccountingComplete` observes the original route accounting boundaries, not a
new end-of-request flush: `attempt` counts calls; `usage` runs token billing at
-200 then quota persistence at -100. Numeric usage bypasses billing ratios.
The original awaited versus fire-and-forget route calls are preserved. It can
fire more than once for streaming usage snapshots; it is not deduplicated.
`onComplete` remains the generation lifecycle notification, not an accounting
barrier. Do not perform the same accounting in both hooks.

Admission, model catalog, normalization and request exceptions propagate.
Accounting attempt errors propagate; usage errors are logged and swallowed at
the ingress accounting boundary, matching legacy tracking. Response, stream,
error and lifecycle-complete hook errors are logged and processing continues.
Return replacements instead of mutating inputs before throwing.
See [Request pipeline](request-pipeline.md) for the original generation framing
boundaries; the additional policy stages documented here supersede its old
separate-normalization-registry description.

`onModelsRefreshed` runs after the existing model-refresh endpoint discovers the
current catalog. Quota uses it to prune stale stored model references; failures
propagate to the refresh caller.

## Built-in plugins and assembly

Eight always-on policy plugins ship under `builtin/<plugin-id>/`: rate-limit,
fallback, access-control, quota, token-billing, thinking-policy,
cch-normalization and stats. Upstream implementations ship in six additional
built-ins: `provider-openai`, `provider-claude`, `provider-gemini`,
`provider-codex`, `provider-claude-subscription`, and `provider-antigravity`.
Three more built-ins, `ingress-openai`, `ingress-claude`, and `ingress-gemini`,
own their Nuxt routes, parsers, serializers, stream consumers and admission
metadata. Public URLs, rejection envelopes and the six codec IDs remain unchanged:
`openai-chat`, `openai-completion`, `openai-responses`, `claude-messages`,
`claude-completion`, `gemini-generate` (also their parser precedence).
Shared structured-output conversion lives in `builtin/shared/`; Responses thinking
state and Gemini schema helpers remain provider-owned and are imported by ingress.
The core has no concrete protocol registration table or ingress-name dispatch.

Provider adapters, discovery, management declarations, and applicable login/token
and subscription-usage implementations live in those directories, not in
`server/providers/`. That directory retains generic loading and routing.

`builtin/catalog.ts` is the runtime registration list. Root `nuxt.config.ts`
separately scans `builtin/*/nuxt.config.ts` for Nuxt layers; it does not import
the catalog or execute server plugin imports during configuration loading.
Add a catalog entry for runtime registration and a layer configuration when a
built-in needs Nuxt integration, such as file-based login routes.

Built-in host registration preserves the persisted protocol IDs `openai`,
`claude`, `gemini`, `codex-subscription`, `claude-subscription`, and
`antigravity-subscription` (see `builtin/provider-ids.ts`); they are not prefixed
with the plugin ID. Runtime provider IDs still use `<pluginId>:<localId>`.

Built-ins are not independent packages: Codex shares OpenAI's Responses codec,
Claude subscription extends the Claude adapter, and Antigravity uses Gemini
conversion. Common subscription helpers live in `builtin/shared/`; ingress
Responses/Gemini code also imports the provider-owned thinking-state/schema
helpers. These explicit internal dependencies do not grant runtime plugins
permission to import gateway build internals.

Built-ins use the same `setup(api)` contract, including async setup and cleanup,
but may import internal gateway modules and retain legacy storage keys. Their
injected storage uses `builtin-plugins:<id>:storage:` for new plugin-private data;
existing policy data continues using its original `auth:`, `settings:` and
`stats:` keys. Login brute-force protection remains in the core AuthStore,
sharing the unchanged configuration record with the request rate-limit plugin.

Nitro startup awaits assembly before serving. Non-Nitro callers must explicitly
`await initializeBuiltinPlugins()` from `builtin/assembly.ts` before using the
shared registries (provide a `useStorage` implementation when exercising policy
storage). The function is idempotent. Tests may instead create a
`BuiltinPluginHost` with injected registries/storage and await `register(plugin)`.
Core registry and pipeline modules do not assemble plugins themselves.

`GET /api/hub/plugins` includes records with `builtin: true`, registered provider
and hook IDs. The dashboard displays them read-only. Enable, disable, reload,
configuration mutation and uninstall are rejected, and runtime installation
cannot replace a built-in ID. Shutdown cleanup is process lifecycle, not a user
uninstall operation. Built-in file-based management routes keep their URLs;
`registerRoute` uses the same namespaced URL as runtime plugins.

### Routes and custom pages

A route registered as `('GET', 'status', handler)` is available only at
`/api/hub/plugins/<id>/api/status`. Paths are exact, not routing patterns. Handlers
receive the H3 event and may return JSON-compatible objects. Dashboard session
authentication applies automatically; client API keys are not dashboard sessions.
Plugin handlers must avoid returning secrets themselves.

`ui.page` appears in a sandbox iframe at `/plugins/<id>`. Use a subdirectory such
as `ui/` for pages and relative assets. The page endpoint serves HTML, CSS, JS,
SVG, PNG, JPG, JSON, and WOFF2 only, and disallows source/config files outside the
page's asset subtree. The iframe and response CSP permit scripts but not
same-origin privileges, networking, forms, or top-level navigation. Consequently
custom pages cannot directly call authenticated management APIs; use the standard
schema form for gateway configuration. No privileged postMessage bridge exists.

## Lifecycle and limits

- Installation creates a disabled plugin. Startup scans disk and loads persisted
  enabled plugins independently. Lists distinguish installed, disabled, enabled,
  and error states; failures include a sanitized error message.
- Import/setup has a bounded wait (default five seconds). A failed plugin loses
  its tracked registrations and cannot stop discovery of other plugins.
- Disable revokes tracked providers, hooks, routes, and config listeners and calls
  the optional cleanup function (default one-second cleanup bound). Already
  running requests are not forcibly aborted. Own timers/sockets need cleanup.
- Enable/reload imports the entry through a native dynamic `import()` with a new
  URL generation, outside Rollup's module graph. Reload re-reads the manifest;
  an already-disabled plugin remains disabled.
- Uninstall removes the directory, configuration, and plugin-scoped storage. It
  does not remove providers referring to its protocol.

ESM modules cannot truly be unloaded; repeated reloads retain module instances.
Avoid side effects at
module top level, especially because single-file validation imports from a
staging directory before activation. Timeout bounds asynchronous waits, not CPU
execution: a synchronous infinite loop blocks the shared process. Timed-out
promises cannot be cancelled; late API registration/storage access is rejected,
but arbitrary external side effects are not reversible. These are consequences
of the trusted, in-process design, not security isolation guarantees.

## Built-in dashboard contributions

Built-in Nuxt layers own client-side components and pages as well as server
modules. The client discovery modules under `composables/` use eager
`builtin/*/dashboard-*.ts` globs; the server catalog is never imported into the
browser. Add contribution files inside the already registered layer, without
modifying root pages. These are build-time, trusted Vue components, not the
runtime plugin iframe contract.

Client contracts live in `shared/dashboard/`:

- `dashboard-navigation.ts`: `DashboardNavigationItem[]` with `label`, `to`,
  `order`; core links and contributions are sorted by numeric order.
- `dashboard-provider.ts`: `DashboardProviderExtension` supplies picker metadata,
  connection and advanced forms, list badges/actions/details, defaults,
  `edit(form, provider)`, `payload(form)`, optional validation and a per-page
  `create(context)` session. Sessions own OAuth polling, cancellation and usage
  state. Unknown/runtime types keep `PluginSchemaForm` and `connectionSchema`.
- `dashboard-provider-section.ts`: `DashboardProviderSection` contributes common
  advanced controls plus `defaults`, `edit(form, provider)` and `payload(form)`;
  CCH normalization uses this path for built-in and runtime provider records.
- `dashboard-api-key.ts`: `ApiKeyDashboardExtension.create(context)` returns
  ordered component sections plus optional `load()`, `reset(record?)`,
  `payload()` lifecycle methods. Slots are badge, summary, meter, details and
  editor. Symbol-keyed capabilities share the access-control catalog with quota
  and fallback without teaching the shell policy fields.
- `dashboard-sections.ts`: `DashboardSectionExtension.create()` returns ordered
  page sections and optional `load()`, `hydrate(data)`, `decorate(record)` and
  `payload()`. Models and security keep their orchestration; billing, request
  limits and SSRF state belong to their respective layers. The existing shared
  security GET/PUT and stored configuration remain unchanged.
- `dashboard-home.ts`: home contributions supply ordered endpoint/action/metric/
  usage components and optional `create()` sessions with `load()`, `commit()`,
  `afterLoad()` and component-props factories. The ingress layers own endpoint
  cards and chat action; statistics owns usage data and displays. Commit runs
  only after all initial requests succeed, retaining the old failure boundary.

Keep reactive state in page sessions, not module singletons. Extract template
fragments without additional wrapper boxes or attribute fallthrough. Whole-page
moves preserve filenames: thinking belongs to thinking-policy; the existing
multi-protocol playground lives with its default OpenAI ingress and retains all
existing protocol flows. Explicit cross-plugin UI dependencies are allowed for
these always-on built-ins, just as shared codecs are on the server.

`npm test` includes `tests/dashboard-render.test.mjs`: it compiles original SFCs
from the pinned pre-split Git commit and current SFCs, supplies identical fixture
state and UI doubles, and compares SSR HTML after removing Vue comment anchors
and normalizing whitespace. Coverage includes provider create/edit forms,
subscription pending/failed login and collapsed/expanded usage, populated key
editors, security, model ratios, thinking and desktop/mobile navigation. This
is supplemented by `tests/dashboard-behavior.test.mjs`, which executes both
versions' scripts to check loading barriers, POST/PUT sequences and payloads,
plus extension state isolation, catalog reactivity and save failures. Neither
is a pixel screenshot or browser interaction test: real OAuth, clipboard, popup,
timers, hydration, responsive layout and actual Nuxt UI dialogs still need
manual acceptance. `DASHBOARD_BASELINE` may override the source baseline;
preserve the original commit in repositories used to run this regression test.

## Management endpoints

All paths below require the existing dashboard session:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/hub/plugins` | Records, manifests, statuses, errors, provider/hook/protocol/ingress IDs |
| POST | `/api/hub/plugins/install` | Multipart `file` containing one `.mjs`; Content-Length required |
| POST | `/api/hub/plugins/scan` | Discover manually installed directories |
| POST | `/api/hub/plugins/<id>/enable` | Activate |
| POST | `/api/hub/plugins/<id>/disable` | Deactivate |
| POST | `/api/hub/plugins/<id>/reload` | Refresh manifest/code |
| DELETE | `/api/hub/plugins/<id>` | Uninstall files, state, and storage |
| GET / PUT | `/api/hub/plugins/<id>/config` | Read sanitized / merge validated configuration |
| GET | `/api/hub/plugins/<id>/page/<path>` | Read allowed page/assets |
| Registered method | `/api/hub/plugins/<id>/api/<path>` | Plugin-owned handler |
| GET | `/api/hub/provider-types` | Available built-in/plugin types and connection schemas |

### Package and market API contracts

All endpoints below use the same hub session authentication, not API keys.
JSON mutations return the updated `PluginRecord[]` unless noted. List records add
`source: { type: 'builtin' | 'npm' | 'github' | 'directory' | 'upload',
packageName?, range?, owner?, repo?, ref?, commit?, specification?, direct? }`.
`direct: false` package records cannot be individually upgraded/uninstalled.
Records also expose `capabilities?: { update: boolean, uninstall: boolean }` for
package-source actions. Existing list/enable/disable/config/upload response
shapes remain compatible.

| Method and path (under `/api/hub/plugins`) | Input | Response |
| --- | --- | --- |
| `POST /install-npm` | `{ name: string, version?: string, force?: boolean }` | Updated records; `version` is a semver version/range |
| `POST /install-github` | `{ owner, repo, ref?, force? }` or `{ url, force? }` | Updated records with resolved commit |
| `GET /sources` | None | Object keyed by direct package name, containing validated source/specification and npm range or GitHub owner/repo/ref/commit |
| `GET /capabilities` | None | `{ npm: { available, version?, reason? }, git: { available, version?, reason? } }`; checks executable availability, not network access |
| `GET /registry` | None | `{ registry: string }` |
| `PUT /registry` | `{ registry: string }` | Normalized persisted `{ registry }`; HTTP(S), no credentials/query/fragment |
| `GET /<id>/updates` | None | `{ available, currentVersion, latestVersion?, latestMatchingVersion?, updates: [{ version, ref?, commit? }], reason?, trackedRef?: { ref, currentCommit?, commit, changed } }`; unavailable queries return `available: false` with reason |
| `POST /<id>/update` | `{ specification?: { name, version? } \| { owner, repo, ref? } \| { url }, force?: boolean }` | Updated records; omission re-resolves saved source, `force` permits downgrade but never bypasses validation |
| `DELETE /<id>` | None | Updated records; npm/GitHub removal uses the project transaction, local/upload removal retains previous behavior |
| `GET /market` | Query `query?`, `page?` (1–1000), `pageSize?` (1–100), `sort?` (`relevance`, `downloads`, `updated`, `name`) | `{ items, total, page, pageSize, sort, sortScope, registry, apiVersion }` |
| `GET /market/detail` | Query `name` (URL-encoded npm package name) | Package summary plus `readme`, `readmeTruncated`, `versions`, `releases`, `registry`, `apiVersion` |
| `DELETE /market/cache` | None | `{ cleared: number }` |

Successful npm update queries include `latestVersion` from `dist-tags.latest` and
`latestMatchingVersion` from published versions satisfying the saved range
(`null` when none match). GitHub results include semver-named refs and tracked
branch/HEAD commit changes; tags use their peeled commit when annotated.

Market summaries contain npm `name`, `version`, optional `pluginId`, `displayName`,
`description`, `publisher`, `date`, `score`, `author`, `license`, `keywords`,
HTTP(S)-only `links`, `engines`, `compatibility`
(`compatible`/`incompatible`/`unknown`), `compatibilityReason`, `installed`,
`installedVersion`, `updateAvailable`, and optional `metadataUnavailable`.
Details expose each release's `version`, `engines`, npm `dependencies` and
`peerDependencies`, `pluginDependencies`, `optionalPluginDependencies`, and
`dependencyStatus` entries with `id`, `range`, `optional`, `builtin`, `version`,
`satisfied`, and a failure `reason`. Installed built-ins participate in those
checks. Release lists are bounded to 1000 entries.

Search uses the configured registry's `/-/v1/search` with
`keywords:llmhub-plugin`, offset and size. npm ranking supports relevance and
popularity; `downloads` requests popularity weighting, not an invented download
count. `updated`/`name` sort the returned page only (`sortScope: 'page'`), while
ranking sorts report `sortScope: 'registry'`. Registry text is returned as data,
never rendered HTML. README is capped at 128 KiB; consumers must render Markdown
with raw HTML disabled and escape other text. Metadata responses are capped at
4 MiB and cached for 60 seconds (up to 100 entries), keyed by registry URL; local
installation status is recomputed. Registry calls enforce outbound URL/SSRF
policy and timeouts through the shared outbound wrapper; HTTP redirects are
refused. The existing policy rejects private/loopback addresses even when domain
allowlisting is disabled; private-network registry installation via npm can work
while market requests are blocked. Public installation does not require market
search to work.

Market failures carry HTTP status plus `data.code` (for example
`SEARCH_UNSUPPORTED` with HTTP 501 when the registry lacks search,
`PACKAGE_NOT_FOUND`, `REGISTRY_BLOCKED`, or `REGISTRY_TIMEOUT`). Package mutation
validation errors use the existing sanitized manager error response (HTTP 400,
or 404 for not found). Subprocess stderr is not exposed because it can contain
credentials. Remote update lookup failures use the explicit `available: false`
response instead of implying there are no updates.

Tests in `tests/plugins.test.ts` and `tests/plugin-provider.test.ts` cover runtime
and credential boundaries. `tests/e2e/plugins.test.mjs` installs both examples,
checks OpenAI/Claude/Gemini streaming and non-streaming calls, verifies hook
removal, reload, disabled-provider behavior, and built-in health, then removes its
fixtures. Run the normal acceptance sequence: `npx vue-tsc --noEmit`, `npm test`,
`npm run build`, and `npm run test:e2e`.

## Plugin API versions, dependencies and upgrades

This section supersedes the earlier scan/upload and API-surface descriptions.
The kernel exports `PLUGIN_API_VERSION = '1.0.0'` from
`server/core/plugin-version.ts`. This is **not** the application version. Adding
hooks or optional API fields increments its minor version; changing signatures
or removing functionality increments its major version; compatible fixes increment
its patch version. Built-in manifest versions come from root `package.json` and
are bundled at build time (also available through the non-Nitro assembly).

```js
export const manifest = {
  id: 'my-consumer', name: 'My Consumer', version: '1.0.0',
  engines: { llmhub: '^1.0.0' },
  dependencies: { 'example-text-service': '^1.0.0' },
  optionalDependencies: { 'example-audit-service': '^1.0.0' }
}
```

Version/range parsing uses `semver`. `engines.llmhub` targets the plugin API.
Incompatible plugins fail before their module or setup is executed, with both
required range and current version reported. Missing `engines.llmhub` remains
supported and produces a warning. Already installed legacy manifests with invalid
semver versions still load with a warning; they cannot satisfy a versioned
dependency. New uploads and changed directory versions require valid semver.
Existing state requires no migration.

Uploads extract the manifest **without executing JavaScript**. Use a literal
`export const manifest = { ... }`, optionally preceded by comments and static ESM
imports. Objects, arrays, quoted strings, finite decimal numbers, booleans/null,
comments and trailing commas are supported. Computed values, spreads, getters,
template literals, import attributes and arbitrary statements before the manifest
are rejected; use a directory with `plugin.json` instead. After validation the
module still executes with full process privileges: this is not a sandbox and
installation still requires trust.

Legacy `plugin.json` dependencies name **plugin IDs**, including built-ins, not
npm packages. In the package format described below, those declarations move to
`llmhub.dependencies` and `llmhub.optionalDependencies`; top-level npm dependencies
are libraries installed by npm. Built-in catalog dependencies describe existing
direct imports; those imports remain unchanged.

Startup discovers manifests before activation, orders runtime plugins by stable
topological layers, and isolates dependency cycles. Cycle members fail with their
IDs; required dependents fail pointing to the unavailable dependency, while
unrelated plugins continue. Built-in assembly pulls dependencies forward while
preserving existing ingress parser precedence; dashboard listing retains catalog
order. Required dependencies must be installed, enabled, healthy and satisfy the
range before enable. All unmet required dependencies are reported together.
Missing, disabled or incompatible optional dependencies do not prevent activation.
Stopping or uninstalling a plugin is refused while an enabled plugin requires it;
there is no cascading disable. Reload/upgrade restarts enabled transitive
consumers in dependency order, including optional consumers.

The shared runtime/built-in API adds:

```ts
provide(value: object): void
require<T extends object = Record<string, unknown>>(pluginId: string): T | undefined
```

Call `provide` during setup to publish an object (the last provided object wins). `require` permits only IDs
in the caller's required or optional dependencies. It returns the currently
available, range-compatible export, or `undefined` when unavailable or when the
provider published nothing. Required dependency activation does not guarantee an
export: check it in setup when your plugin needs one. Stopped generations cannot
publish or acquire exports; newly executing code never receives an old export
through `require`. These are object references, not revocable proxies: code that
already retained an object must release it during cleanup. See
`examples/plugins/text-service.mjs` and `text-consumer.mjs`.

Uploading an existing single-file ID upgrades in place only when the incoming
version is newer. Same-precedence versions (including build metadata changes) or
downgrades require multipart text `force=true`; absent/`false` does not force, and
other values or duplicate force fields are rejected. Force bypasses only version
ordering, never compatibility/dependency checks. Configuration, private storage
and enabled state are preserved. Failed validation/setup/dependency activation
rolls back the files and previous running generations; rollback failures are
reported explicitly rather than claiming successful recovery. Disabled plugins
stay disabled. Directory replacements are recognized by version on Scan and by
Reload; downgrade checks still apply. Keep a backup before replacing directory
files yourself: the gateway cannot restore bytes overwritten externally.
Disabled replacements run setup and cleanup transactionally for validation, but
remain disabled afterward; initial fresh installation still waits for Enable.

Initial local enable and single-file validation retain their existing entry locations.
Npm-installed packages, and local plugins after explicit Reload (or Scan detecting
a changed version), load from a private snapshot of the plugin's code and assets
under `<plugins directory>/.generations/`. This refreshes relative imports,
including lazy imports, and keeps assets until stop. Source symlinks and
nonregular files are rejected. Library trees are never copied: `node_modules`
directories inside the plugins directory (the plugin's own and the npm project's)
are mirrored as hard links, so bare imports resolve in the same order as from the
original location and both ESM and CommonJS libraries refresh on upgrade. Because
snapshots live inside the plugins directory, the links never cross filesystems.
Libraries above the plugins directory are not mirrored: they resolve in place and
are not refreshed until the gateway restarts. Scoped npm packages are supported.
`import.meta.url` points into the snapshot; writes there are ephemeral, so use
plugin storage for durable state. Relative imports outside the plugin directory
are not preserved. Do not mutate dependency files in place: managed npm upgrades
replace whole trees. Snapshots are removed on stop or failure, again after
timed-out work settles, and any left behind by a crash are removed at startup.

`GET /api/hub/plugins` remains an array for compatibility. Each record includes
`apiVersion`, `manifest.version`, `manifest.engines`, dependency declarations,
`dependencies` entries (`id`, `range`, `optional`, `satisfied`, `version`, `reason`),
`requiredBy`, and `warnings`. The dashboard augments existing cards with these
fields, displays lifecycle refusal reasons and successful old → new versions,
and requires a separate confirmation before forced replacement.

Author declarations live in the single `examples/plugins/llmhub-plugin.d.ts`.
Reference it from `.mjs` JSDoc, for example
`/** @param {import('./llmhub-plugin').PluginAPI} api */`.
It uses standard Node/DOM environment types, not gateway imports. Its event type
exposes the portable public event surface, not H3's private routing/session or
WebSocket internals. `tests/plugin-api.type-test.ts` checks the public contract
against real kernel types using TypeScript, including a separately checked event
projection; `tests/run-all.sh` runs this check before runtime tests. Dependency,
version, lifecycle and rollback regression tests accompany a real HTTP e2e flow
that installs two plugins, checks exported-interface use, rejects provider
removal, upgrades the provider, and verifies the consumer uses the new instance.
