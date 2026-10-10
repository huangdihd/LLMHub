# Plugin reference

Everything a runtime plugin can declare and call. For a guided introduction see
[Getting started](getting-started.md).

- [Manifest](#manifest)
- [Fields](#fields)
- [The plugin API](#the-plugin-api)
- [Hooks](#hooks)
- [Providers](#providers)
- [Client protocols and ingress](#client-protocols-and-ingress)
- [Management routes](#management-routes)
- [Dashboard contributions](#dashboard-contributions)
- [Panels](#panels)
- [Depending on other plugins](#depending-on-other-plugins)
- [Libraries](#libraries)
- [Versioning](#versioning)
- [Lifecycle](#lifecycle)
- [Installing and updating](#installing-and-updating)
- [Security](#security)
- [Management HTTP API](#management-http-api)

## Manifest

A plugin is an npm package whose `package.json` has an `llmhub` block.

```json
{
  "name": "@example/llmhub-plugin-text-service",
  "version": "1.0.0",
  "description": "A text service",
  "type": "module",
  "main": "index.mjs",
  "keywords": ["llmhub-plugin"],
  "engines": { "llmhub": "^1.1.0" },
  "dependencies": { "tiny-library": "^1.0.0" },
  "llmhub": {
    "id": "text-service",
    "name": "Text service",
    "configSchema": [],
    "dependencies": { "provider-openai": "^1.0.0" },
    "optionalDependencies": { "audit-service": "^1.0.0" },
    "contributes": {},
    "ui": { "page": "ui/index.html" }
  }
}
```

### npm fields

| Field | Meaning |
| --- | --- |
| `name` | Required. The npm package name. |
| `version` | Required. Valid semver. |
| `description` | Shown in the dashboard and the market. |
| `main` / `exports` | The entry file. `exports` (the package root's `import` or `default` target) wins, then `main`, then `index.mjs`. Must be JavaScript: `.mjs`, `.js` or `.cjs`. |
| `type` | Node's usual meaning for `.js` files. |
| `engines.llmhub` | Semver range of the [plugin API](#versioning) this plugin works with. An incompatible plugin is refused before any of its code runs. Omitting it is allowed and produces a warning. |
| `dependencies` | npm libraries your code imports. See [Libraries](#libraries). |
| `keywords` | Include `llmhub-plugin` to appear in the market. |

### `llmhub` fields

| Field | Meaning |
| --- | --- |
| `id` | The plugin's ID: `^[a-z0-9][a-z0-9-]{1,40}$`, unique among installed and built-in plugins. Defaults to the package name without its scope and without a leading `llmhub-plugin-`. For a plugin in a local folder it must equal the folder name. |
| `name` | Display name. Defaults to the package name. |
| `configSchema` | [Fields](#fields) for the plugin's own settings. |
| `dependencies`, `optionalDependencies` | Other plugins this one needs, by plugin ID. See [Depending on other plugins](#depending-on-other-plugins). |
| `contributes` | [Dashboard contributions](#dashboard-contributions). |
| `ui.page` | An HTML file shown on the plugin's detail page. Prefer a `detail` [panel](#panels), which can also talk to your routes. |

Paths in the manifest are relative to the plugin folder. Absolute paths, `..`,
encoded path components, backslashes and symlinks are rejected.

### `plugin.json`

The older manifest format, `plugin.json`, is still read. It puts `id`, `name`,
`version`, `entry`, `configSchema`, `dependencies`, `optionalDependencies`,
`contributes` and `ui` at the top level, and its `dependencies` name plugin
IDs. When a folder has both files, `package.json` is used. Write new plugins
with `package.json`.

## Fields

Settings, provider connection forms and dashboard contributions all describe
their inputs the same way:

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

- `key` matches `[a-zA-Z][a-zA-Z0-9_]*` and is unique within its list. A list
  holds at most 100 fields.
- `select` requires `options`. A `secret` cannot have a default.
- Values are checked against the declared type with no conversion: `"5"` is
  not accepted for a `number`. Unknown keys are rejected.
- Required fields must be filled in before the plugin can be enabled.

**Secrets** are never returned to the dashboard once saved. When saving,
leaving a secret out, sending an empty string, or sending the mask
(`********`) keeps the stored value; sending `null` clears an optional secret.
Your server code receives the real value. Secrets are stored in plain text
under `.data`, so protect and back up that directory accordingly.

## The plugin API

The entry module's default export has a `setup` function. It receives the API
and may return a cleanup function.

```ts
interface PluginModule {
  setup(api: PluginAPI): void | Cleanup | Promise<void | Cleanup>
}
type Cleanup = () => void | Promise<void>

interface PluginAPI {
  // Settings
  readonly config: Readonly<Record<string, unknown>>
  onConfigChange(listener: (config: Readonly<Record<string, unknown>>) => Awaitable<void>): void

  // Request pipeline
  registerHook(hook: RequestHook): void
  registerProvider(definition: ProviderDefinition): void
  registerProtocol(definition: ProtocolDefinition): void
  registerIngress(definition: IngressDefinition): void

  // Management
  registerRoute(method: string, path: string, handler: (event: H3Event) => Awaitable<unknown>): void
  registerMetric(key: string, getter: PluginMetricGetter): void

  // Values attached to models, API keys and providers
  getRecordValues(location: PluginRecordLocation, recordId: string): Promise<PluginRecordValues>
  getAllRecordValues(location: PluginRecordLocation): Promise<Record<string, PluginRecordValues>>
  onRecordValuesChange(listener: (change: PluginRecordValuesChange) => Awaitable<void>): void

  // Other plugins
  provide(value: object): void
  require<T extends object = Record<string, unknown>>(pluginId: string): T | undefined

  // Private storage and logging
  storage: {
    getItem<T>(key: string): Promise<T | null>
    setItem<T>(key: string, value: T): Promise<unknown>
    removeItem(key: string): Promise<unknown>
  }
  logger: Pick<Console, 'info' | 'warn' | 'error'>
}
```

The full declarations, including every type named here, are in
`examples/plugins/llmhub-plugin.d.ts`.

**Register during `setup`.** Every `register*` and `on*` call must happen
before `setup` finishes (including work it awaits). Later calls are rejected.

**IDs are local.** Hook, provider, protocol and ingress IDs match
`[a-z0-9][a-z0-9-]{0,63}`. LLMHub prefixes them with `<pluginId>:`, so a
provider registered as `echo` by the plugin `example-echo` has the type
`example-echo:echo`. Registering an ID twice fails; a plugin cannot replace
another plugin's or a built-in's registration.

**`config`** is a read-only snapshot of the current settings. Read it when you
need a value, or subscribe with `onConfigChange`. A change is saved before
listeners run. If a listener throws, the plugin is stopped rather than left
half-updated.

**`storage`** is private to the plugin and survives restarts and updates. Keys
are made of letters, digits, `_` and `-`, optionally separated by `/`. It is
removed when the plugin is uninstalled.

**`logger`** prefixes messages with the plugin ID. Do not log credentials:
hook contexts and provider configurations contain them.

Throw ordinary `Error` objects to signal failure.

## Hooks

A hook is an object with an ID, an optional priority and any of the stage
functions below.

```ts
interface RequestHook {
  id: string
  priority?: number

  // Admission: may reject the request
  onBeforeIdentity?(context: AdmissionContext): Awaitable<AdmissionRejection | void>
  onAfterIdentity?(context: AdmissionContext): Awaitable<AdmissionRejection | void>
  onModelResolved?(context: AdmissionContext): Awaitable<AdmissionRejection | void>

  // Model list
  onModels?(models: ModelInfo[], context: HookContext): Awaitable<ModelInfo[] | void>
  onModelsRefreshed?(validModelIds: ReadonlySet<string>): Awaitable<void>

  // Generation
  onRequest?(request: LLMRequest, context: HookContext): Awaitable<LLMRequest | void>
  onResponse?(response: LLMResponse, context: HookContext): Awaitable<LLMResponse | void>
  onStreamChunk?(chunk: LLMStreamChunk, context: HookContext):
    Awaitable<LLMStreamChunk | LLMStreamChunk[] | null | void>
  onError?(error: unknown, context: HookContext): Awaitable<void>
  onComplete?(completion: CompletionInfo, context: HookContext): Awaitable<void>
}
```

Hooks run in ascending `priority` (default 0); equal priorities run in
registration order. Returning nothing leaves the value unchanged.

### Admission

Admission hooks run for `POST` requests on a client endpoint, before the body
is parsed into a unified request. They also cover embeddings.

```ts
interface AdmissionContext {
  event: H3Event
  incomingProtocol: string   // 'openai', 'claude' or 'gemini'
  apiKeyRecord?: ApiKeyRecord
  model: string
}
interface AdmissionRejection { status: number; message: string; code: string }
```

| Stage | When | Built-in plugins at this stage |
| --- | --- | --- |
| `onBeforeIdentity` | Before the API key is looked up | Rate limiting by IP |
| `onAfterIdentity` | The key is known | Monthly quota |
| `onModelResolved` | The requested model is known and non-empty | Fallback (−300), access control (−200), model and provider quotas (−100) |

Return an `AdmissionRejection` to refuse the request; the first rejection wins
and the client receives it in its own protocol's error format. To send the
request to a different model, assign `context.model` in `onModelResolved`.

A dashboard session that is not impersonating an API key skips
`onAfterIdentity` and `onModelResolved`.

### Model list

`onModels` runs when a client lists models and may filter or add entries.
`onModelsRefreshed` runs after models are refreshed from providers, with the
set of model IDs that now exist; use it to prune stored references. An error
here fails the refresh.

### Generation

| Stage | Receives | Return to change it |
| --- | --- | --- |
| `onRequest` | The unified request, before it is sent upstream | A new request |
| `onResponse` | A non-streaming response | A new response |
| `onStreamChunk` | Each streamed chunk | A chunk, an array of chunks to expand it, or `null` / `[]` to drop it |
| `onError` | An upstream or pipeline error | — |
| `onComplete` | Final usage or error, once per request | — |

```ts
interface HookContext {
  incomingProtocol: string
  providerName?: string
  providerConfig?: ProviderConfig
  apiKeyRecord?: ApiKeyRecord
}
```

`context.incomingProtocol` identifies the client wire format (for example
`claude-messages` or `openai-chat`), so a hook that applies to only one of them
can check it and return early.

The unified request, response, chunk, message, tool-call and usage types are
declared in `llmhub-plugin.d.ts`.

### Completion

```ts
interface CompletionInfo {
  model?: string
  usage?: Usage
  error?: unknown
}
```

`onComplete` runs exactly once for each admitted generation or embedding
request, including route parsing failures and upstream failures. Admission
rejections do not reach the route and do not emit completion. Model-list and
unsupported endpoints are not generation or embedding requests.

`model` is the final selected model, including request-hook rewrites; embeddings
use the returned model when supplied, qualified with the provider name.
It can be absent when the request fails before a model is selected.
`usage` is the last observed cumulative usage snapshot, not the sum of stream
updates. No reported usage means `undefined`. Embeddings expose their total
reported tokens as `promptTokens`, with `completionTokens: 0`.
`error` is the last observed failure. A client disconnect records an error but
does not stop upstream consumption: completion waits for upstream EOF or failure
so it includes the final available usage.

Completion work is retained by a process-owned promise set and runs without
waiting for persistence before returning the HTTP response. Exceptions are
logged independently for each hook. A process crash can lose pending work;
completion is not a durable job queue. Core callers and tests can await
`drainCompletions()` to wait for pending work.

Stats counts one call at completion. Quota counts one call for a persisted API
key, even without usage, and records tokens only when usage is available.
Quota declares a required dependency on token billing and calls its
`api.provide` / `api.require` conversion interface; embedding usage also uses
model token ratios.

### Errors in hooks

| Stage | An exception... |
| --- | --- |
| Admission, `onModels`, `onRequest` | fails the request |
| `onResponse`, `onStreamChunk`, `onError`, `onComplete` | is logged; the request continues |

Return a replacement rather than mutating the value you were given, so that a
failure partway through leaves it intact.

## Providers

`registerProvider` adds an upstream type that users can then create providers
from.

```ts
interface ProviderDefinition {
  id: string
  displayName?: string
  connectionSchema?: PluginField[]
  secretConnectionFields: readonly string[]
  createAdapter(configuration: ProviderConfig): ProviderAdapter
  fetchModels(configuration: ProviderConfig,
    context: { fetcher(url: string, options?: RequestInit): Promise<Response> }
  ): Promise<ModelInfo[]>

  // Optional
  management?: ProviderManagement
  requiresRefreshToken?: boolean
  refreshAccessToken?(configuration: ProviderConfig): Promise<ProviderConfig>
  subscriptionUsage?(configuration: ProviderConfig, fetcher: typeof fetch): Promise<SubscriptionUsage>
  resetSubscriptionUsage?(configuration: ProviderConfig, creditId: string | undefined,
    idempotencyKey: string, fetcher: typeof fetch): Promise<SubscriptionResetResult>
  login?: { path: string }
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

`examples/plugins/echo/` is a complete, working provider.

**Connection settings.** Fields in `connectionSchema` are rendered in the
provider form and arrive in `configuration.connection.extra`. `secret` fields
are masked automatically. List any other credential paths in
`secretConnectionFields`, or pass `[]`.

**Models.** `fetchModels` returns model IDs prefixed with the provider's name,
such as `<providerName>/echo`. The `fetcher` it is given has a ten-second
timeout and one retry.

**Streaming.** `callStream` returns a stream of UTF-8 server-sent events: lines
of `data: <json>`. Each parsed object is passed to `fromProviderStreamChunk`,
which turns it into unified chunks. End the stream with `data: [DONE]`.

**When the plugin is disabled or removed**, providers created from its type
are kept but become unavailable, and requests skip them. They work again when
the plugin returns.

**`management`** adjusts how the generic provider form and API treat this
type:

| Field | Effect |
| --- | --- |
| `acceptsExtra` | Whether `connectionSchema` values are accepted. Defaults to accepted. |
| `creationError` | Refuse direct creation with this message, for types that must be created through a login flow. |
| `protectedConnectionFields` | Connection fields that updates may not change. |
| `flatConnectionFields` | Normalizers for top-level connection fields. |
| `createConnectionDefaults` | Values for connection fields still unset after creation. |
| `flatCreateCredentials` | Read credentials from the flat request body on creation. |

**`subscriptionUsage` and `resetSubscriptionUsage`** power the usage panel and
reset action for subscription-style providers.

**`refreshAccessToken` and `login.path` are declarations only.** LLMHub does
not call them for runtime plugins. Refresh tokens from your adapter, and
implement login with your own routes and a [panel](#panels).

## Client protocols and ingress

A plugin can register a parser and serializer for a client wire format, and an
ingress definition describing how requests under a path prefix are
authenticated.

```ts
interface ProtocolDefinition {
  id: string
  createParser(): ProtocolParser
  createSerializer(): ProtocolSerializer
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
interface IngressModel { model: string; replace(model: string): void }
```

**A runtime plugin cannot add a public client endpoint.** These registrations
supply codecs and admission behaviour; they do not create a URL. The built-in
OpenAI, Claude and Gemini endpoints are compiled into the gateway. A runtime
plugin can serve requests only from its [management routes](#management-routes),
which require a dashboard login. Adding a public endpoint means writing a
[built-in plugin](builtin.md).

Ingress matching is a plain `startsWith(pathPrefix)` on the request path, in
registration order. Choose a narrow prefix: admission runs for every request
that matches. Exact duplicate prefixes are rejected.

## Management routes

```js
api.registerRoute('GET', 'status', () => ({ ready: true }))
```

serves `GET /api/hub/plugins/<pluginId>/api/status`.

- Paths are exact strings, not patterns.
- Use `GET`, `POST`, `PUT`, `PATCH` or `DELETE`.
- The handler receives the H3 event. Return a JSON-serializable value.
- A dashboard session is required. Client API keys are not accepted.
- Do not return secrets. Responses are not filtered for you.

## Dashboard contributions

Declare what you want to add to the dashboard and LLMHub renders it with its
own components. You ship no front-end code. Requires plugin API 1.1.0.

```json
"llmhub": {
  "contributes": {
    "models": [
      { "key": "priority", "label": "Priority", "type": "number", "default": 0 }
    ],
    "apiKeys": [
      { "key": "team", "label": "Team", "type": "text", "showInList": true }
    ],
    "providers": [
      { "key": "region", "label": "Region", "type": "select", "default": "eu",
        "options": [{ "label": "Europe", "value": "eu" }, { "label": "US", "value": "us" }] }
    ],
    "metrics": [{ "key": "requests", "label": "Requests seen", "icon": "i-heroicons-bolt" }],
    "panels": [{ "id": "status", "title": "Status", "location": "page", "page": "ui/index.html" }],
    "navigation": [{ "panel": "status", "label": "Status" }]
  }
}
```

| Key | Adds |
| --- | --- |
| `models` | [Fields](#fields) on every row of the Models page |
| `apiKeys` | A section, titled with your plugin's name, in the API key editor. A field with `showInList: true` is also shown on the key's card (not allowed for secrets). |
| `providers` | Fields in the provider editor's advanced settings |
| `metrics` | Cards on the home page |
| `panels` | [Panels](#panels): pages of your own |
| `navigation` | Links in the top navigation, each to a `page` panel |

Each list holds at most 100 entries. Metric keys and panel IDs match
`[a-zA-Z][a-zA-Z0-9_-]{0,63}`. Labels, titles and icon names are plain text of
at most 2000 characters. Icons are Heroicons names such as
`i-heroicons-bolt`. An invalid declaration stops the plugin from loading,
before any of its code runs.

Contributions are shown only while the plugin is enabled.

### Reading field values

Values that users enter belong to your plugin and are kept by LLMHub. Read them
from server code:

```ts
type PluginRecordLocation = 'models' | 'apiKeys' | 'providers'

const values = await api.getRecordValues('models', request.model)
const all = await api.getAllRecordValues('apiKeys')

api.onRecordValuesChange(({ location, recordId, values }) => { /* ... */ })
```

Record IDs are the model ID (`provider/model`), the API key's record ID (never
the key itself) and the provider's name.

A typical use, routing by a per-model setting:

```js
api.registerHook({
  id: 'instruction',
  async onRequest(request) {
    const { instruction } = await api.getRecordValues('models', request.model)
    if (!instruction) return
    return { ...request, config: { ...request.config, systemPrompt: instruction } }
  }
})
```

- Missing values come back as the field's default. A record that does not
  exist returns the defaults.
- You can only read locations you declared.
- Server code receives real secret values. Never pass them on through a route,
  a metric, a log line or a panel.
- A change is saved before listeners run. If a listener fails, the save still
  stands and the dashboard reports that notification failed.
- Values are kept when the plugin is disabled or updated, and removed when it
  is uninstalled or when the key or provider they belong to is deleted.

### Metrics

Declare the card, then supply its value during `setup`:

```js
api.registerMetric('requests', () => count)
```

A getter returns a string, a finite number or `null`, directly or as a
promise. If it throws or times out, that one card shows as unavailable; other
cards and the page are unaffected.

## Panels

A panel is an HTML file from your plugin shown inside the dashboard.

```json
"panels": [
  { "id": "status", "title": "Status", "location": "home", "page": "ui/status.html" }
]
```

| `location` | Appears |
| --- | --- |
| `home` | As a card on the home page |
| `detail` | On the plugin's own page under Plugins |
| `page` | As a full page at `/plugin-panels/<pluginId>/<panelId>`, linkable from `navigation` |

`page` is a path to an `.html` file inside the plugin folder.

### What a panel can do

A panel runs in a sandboxed frame with no access to the dashboard: not its
cookies, its DOM or its origin. It cannot make network requests itself.
Instead, LLMHub injects a small helper, `window.llmhub`, that calls **your own
plugin's management routes** on the panel's behalf:

```html
<p id="out">Loading…</p>
<script>
  llmhub.fetch('status').then(status => {
    document.getElementById('out').textContent = `Requests: ${status.requests}`
  })
</script>
```

| Helper | Does |
| --- | --- |
| `llmhub.fetch(path, { method?, body? })` | Calls `/api/hub/plugins/<yourId>/api/<path>` and resolves with the parsed JSON. `body` is a JSON value. |
| `llmhub.theme` | `'light'` or `'dark'` |
| `llmhub:theme` event on `window` | Fires when the theme changes; `event.detail` is the new theme. `document.documentElement.dataset.theme` is kept up to date for CSS. |
| `llmhub.setHeight(pixels)` | Sets the frame's height (120–1200). The helper also resizes automatically as content changes. |

A panel must be self-contained: inline its CSS and JavaScript, and embed
images and fonts as data URLs. External scripts, stylesheets and requests are
blocked.

### Limits

- `fetch` reaches only your own plugin's routes. Other plugins' routes, the
  rest of the management API, other hosts, path traversal and encoded paths
  are refused.
- Methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. No body on `GET`. Bodies
  are JSON, at most 64 KiB and 20 levels deep. You cannot set headers.
- At most 32 requests may be pending at once, and each times out.
- Insert returned text with `textContent`, not `innerHTML`.

The sandbox protects the dashboard from mistakes in a panel. It is not a
security boundary around the plugin as a whole, whose server code already has
full access. In particular, a panel is not prevented from navigating its own
frame elsewhere.

<details>
<summary>Message protocol</summary>

The helper wraps a `postMessage` channel named `llmhub:panel:v1`. You only need
this if you are not using the helper.

Panel to host: `ready`; `height` (integer 120–1200); `fetch` with `requestId`
(`[a-zA-Z0-9_-]{1,64}`), `path`, `method` and optional `body`.

Host to panel: `theme`; `response` with `requestId`, `ok`, and `data` or a
generic `error`.

The host accepts a message only from the exact frame it created, and rejects
messages with unexpected keys. Query strings are limited to
`[a-zA-Z0-9_=&.,~+-]*`.

</details>

## Depending on other plugins

Declare the plugins you need by ID. Built-in plugins can be depended on too.

```json
"llmhub": {
  "dependencies": { "example-text-service": "^1.0.0" },
  "optionalDependencies": { "example-audit-service": "^1.0.0" }
}
```

- Plugins load in dependency order.
- A plugin can be enabled only when every required dependency is installed,
  enabled, healthy and within the declared range. All unmet dependencies are
  reported together.
- A missing or incompatible optional dependency does not block anything.
- A plugin that an enabled plugin requires cannot be disabled or uninstalled.
  Disable the dependent first.
- When a plugin is reloaded or updated, the enabled plugins that depend on it
  are restarted after it, so they see the new version.
- Plugins in a dependency cycle all fail to load, naming the cycle. Unrelated
  plugins are unaffected.

If an npm dependency in your `package.json` is itself an LLMHub plugin, it is
treated as a plugin dependency automatically; you need not list it twice.

### Exposing and using an interface

A dependency is more useful when it offers something. One plugin publishes an
object:

```js
// example-text-service
api.provide({
  format(value) { return `${api.config.prefix}${value}` }
})
```

A plugin that declared the dependency retrieves it:

```js
// example-text-consumer
const text = api.require('example-text-service')
if (!text) throw new Error('Text service is required')
text.format('hello')
```

- `require` works only for plugins listed in your `dependencies` or
  `optionalDependencies`.
- It returns `undefined` if the plugin is unavailable or published nothing.
  Being enabled does not guarantee an interface, so check.
- Resolve optional dependencies when you use them, not once in `setup`: they
  can come and go.
- What you receive is the object itself. Release anything you kept from it in
  your cleanup function.

See `examples/plugins/text-service/` and `text-consumer/`.

## Libraries

List npm libraries in the top-level `dependencies` of `package.json` and
import them normally. They are installed when the plugin is installed from
npm or GitHub.

For a plugin in a local folder, either install its libraries inside the folder
(`npm install` there), or rely on libraries already installed in
`.data/plugins/`, which is itself an npm project.

Do not import LLMHub's own source files. They are not part of the plugin API
and are not present in a deployed build.

## Versioning

The plugin API has its own version, separate from LLMHub's, currently
**1.2.0**. See the [changelog](changelog.md).

| Change | Version bump |
| --- | --- |
| New hooks, methods or optional fields | Minor |
| Changed signatures or removed features | Major |
| Compatible fixes | Patch |

Declare what you need in `engines.llmhub`. `^1.0.0` accepts every 1.x release;
use `^1.1.0` if you rely on something added in 1.1. A plugin whose range the
running gateway does not satisfy is refused with a message naming both, and
none of its code runs.

Your plugin's own `version` must be valid semver. It is what dependents'
ranges are matched against and what updates are compared by.

## Lifecycle

| State | Meaning |
| --- | --- |
| Disabled | Installed. No code has run. |
| Enabled | `setup` completed; registrations are live. |
| Error | Loading or `setup` failed. Its registrations were rolled back. |

- **Install.** A new plugin is always disabled. Its manifest is validated
  without running its code.
- **Enable.** The entry module is imported and `setup` runs, with five seconds
  to finish.
- **Disable.** Registrations are removed and your cleanup function runs, with
  one second to finish. Requests already in flight are not interrupted.
- **Reload.** Re-reads the manifest and code. A disabled plugin stays
  disabled and its code is not run.
- **Update.** Keeps settings, storage, contributed values and the enabled
  state. If the new version fails to validate or start, the previous version is
  restored and keeps running. Updating a disabled plugin does not run it.
- **Uninstall.** Removes the files, settings, storage and contributed values.
  Providers created from its types remain, unavailable.
- **Startup.** Enabled plugins are loaded independently. One failing does not
  stop the others or the gateway.

Things to know when writing a plugin:

- **Avoid side effects at the top level of a module.** If `setup` fails they
  cannot be undone, and they run again on every reload.
- **A reloaded module is a new copy.** Node cannot unload modules, so old
  copies stay in memory. Keep state in `storage`, not in module variables you
  expect to survive.
- **Timeouts limit waiting, not computing.** A synchronous infinite loop
  blocks the whole gateway.
- **`import.meta.url` may point to a temporary copy** of your plugin's files.
  Do not write next to your code; use `storage`.

## Installing and updating

| Source | How |
| --- | --- |
| Market | **Browse market** on the Plugins page. Lists packages on the configured npm registry tagged `llmhub-plugin`. |
| GitHub | **Install from GitHub**, by `owner/repo` or a `github.com` URL, optionally at a tag, branch or commit. |
| Local folder | Put the folder in `.data/plugins/<id>/` and click rescan. For development. |

Market and GitHub installs are carried out by the server's own `npm`, and
GitHub installs also need `git`. If either is missing, that install method is
unavailable and says why; everything else works. The server needs network
access to the registry or to GitHub.

- **No scripts are run.** Packages install with `--ignore-scripts`. A GitHub
  repository must contain a ready-to-load entry file at the chosen ref;
  `prepare` and build steps do not run.
- **Updates.** For npm plugins, LLMHub offers the newest version within the
  installed range and the newest overall. For GitHub plugins it offers newer
  tags named as versions, and new commits on a tracked branch. Downgrading
  must be confirmed explicitly.
- **Registry.** The registry URL can be changed on the market page, to use a
  mirror or a private registry. Put registry credentials in the server's npm
  configuration; LLMHub neither accepts nor shows them. The market requires a
  registry that supports npm's search API; installing by package name works
  without it.
- **Private GitHub repositories** are not specifically supported. They work if
  the server's `git` is already configured with credentials.
- **Failure is rolled back.** If an install or update fails at any step, the
  previous files, settings and running plugins are restored.

## Security

**A plugin has the same power as LLMHub itself.** It runs in the gateway's
process, can read every credential the gateway holds, and can read and write
anything the gateway's user can. There is no sandbox around plugin server
code. Installing or enabling a plugin is a decision to trust its author and
everything it depends on.

What LLMHub does do:

- Validates manifests, versions and dependencies before running any plugin
  code.
- Never runs install scripts, and accepts only package names and GitHub
  repositories as install sources. This reduces accidents; it does not make a
  malicious package safe, because its code runs once enabled.
- Treats everything from the registry (names, descriptions, readmes) as
  untrusted text when displaying it.
- Isolates [panels](#panels) from the dashboard.
- Keeps each plugin's settings, storage and contributed values separate, and
  keeps secrets out of management responses.

What plugin authors must do:

- Never log or return credentials. Hook contexts, provider configurations and
  record values contain them.
- Validate input to management routes. They are behind the dashboard login,
  but that is the only check applied for you.
- Treat data from upstreams and clients as untrusted.

The market is not curated. Anyone can publish a package with the
`llmhub-plugin` keyword.

## Management HTTP API

Everything the dashboard does is available over HTTP. All endpoints require a
dashboard session; client API keys are not accepted. Unless noted, changes
return the updated list of plugin records.

### Plugins

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/hub/plugins` | All plugins, built-in and installed |
| POST | `/api/hub/plugins/scan` | Discover plugins in local folders |
| POST | `/api/hub/plugins/<id>/enable` | Enable |
| POST | `/api/hub/plugins/<id>/disable` | Disable |
| POST | `/api/hub/plugins/<id>/reload` | Reload manifest and code |
| DELETE | `/api/hub/plugins/<id>` | Uninstall |
| GET, PUT | `/api/hub/plugins/<id>/config` | Read settings (secrets omitted) / update settings |
| any | `/api/hub/plugins/<id>/api/<path>` | The plugin's own routes |
| GET | `/api/hub/provider-types` | Provider types and their connection fields |

A plugin record:

```ts
interface PluginRecord {
  id: string
  manifest: PluginManifest
  builtin?: boolean
  enabled: boolean
  status: 'installed' | 'disabled' | 'enabled' | 'error'
  error?: string
  apiVersion: string                 // the gateway's plugin API version
  providers: string[]                // registered IDs
  hooks: string[]
  protocols?: string[]
  ingresses?: string[]
  source?: { type: 'builtin' | 'npm' | 'github' | 'directory'; packageName?: string;
             range?: string; owner?: string; repo?: string; ref?: string; commit?: string; direct?: boolean }
  capabilities?: { update: boolean; uninstall: boolean }
  dependencies?: { id: string; range: string; optional: boolean; satisfied: boolean;
                   version?: string; reason?: string }[]
  requiredBy?: string[]
  warnings?: string[]
}
```

A plugin installed only because another package depends on it has
`source.direct: false` and cannot be updated or removed on its own.

### Installing and updating

Paths are under `/api/hub/plugins`.

| Method and path | Body | Notes |
| --- | --- | --- |
| `POST /install-npm` | `{ name, version?, force? }` | `version` is a semver version or range, not a tag such as `latest` |
| `POST /install-github` | `{ owner, repo, ref?, force? }` or `{ url, force? }` | Only `github.com` |
| `GET /<id>/updates` | — | `{ available, currentVersion, latestVersion?, latestMatchingVersion?, updates: [{ version, ref?, commit? }], trackedRef?: { ref, currentCommit?, commit, changed }, reason? }`. `available: false` with a `reason` means the check itself failed. |
| `POST /<id>/update` | `{ specification?, force? }` | `specification` is `{ name, version? }`, `{ owner, repo, ref? }` or `{ url }`. Omit it to re-resolve the saved source. |
| `GET /capabilities` | — | `{ npm: { available, version?, reason? }, git: { ... } }` |
| `GET /sources` | — | Install sources of directly installed packages |
| `GET`, `PUT /registry` | `{ registry }` | The npm registry URL |

`force: true` permits a downgrade. It never bypasses compatibility or
dependency checks.

### Market

| Method and path | Query | Returns |
| --- | --- | --- |
| `GET /market` | `query?`, `page?`, `pageSize?` (1–100), `sort?` (`relevance`, `downloads`, `updated`, `name`) | `{ items, total, page, pageSize, sort, sortScope, registry, apiVersion }` |
| `GET /market/detail` | `name` | A package summary plus `readme`, `readmeTruncated`, `versions` and `releases` |
| `DELETE /market/cache` | — | `{ cleared }` |

A market item has `name`, `version`, `description`, `publisher`, `author`,
`license`, `date`, `keywords`, `links`, `pluginId`, `displayName`, `engines`,
`compatibility` (`compatible`, `incompatible` or `unknown`) with a
`compatibilityReason`, and `installed`, `installedVersion` and
`updateAvailable`.

Each release in a detail response lists its `engines`, its npm and plugin
dependencies, and a `dependencyStatus` saying whether each plugin dependency
is satisfied on this gateway.

`sort=updated` and `sort=name` order only the returned page (`sortScope:
"page"`); the registry does not offer them. Readmes are cut off at 128 KiB.
Results are cached for a minute.

Errors carry a `data.code`: `SEARCH_UNSUPPORTED` (HTTP 501) when the registry
has no search API, `PACKAGE_NOT_FOUND`, `REGISTRY_BLOCKED` when the registry
address is not allowed, and `REGISTRY_TIMEOUT`.

### Contributions

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/hub/plugin-contributions` | Contributions of enabled plugins: `{ id, name, contributes }[]` |
| GET | `/api/hub/plugin-contributions/metrics` | `{ pluginId, key, label, icon?, value, error? }[]` |
| GET, PUT | `/api/hub/plugin-contributions/<pluginId>/<location>/<recordId>` | Read (secrets omitted) / update one record's values |
| GET | `/api/hub/plugins/<pluginId>/panels/<panelId>` | A panel's HTML |

Encode each path segment separately; model IDs contain `/`. Saving a record's
values is a separate request from saving the model, key or provider itself.
