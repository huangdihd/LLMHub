# Writing runtime plugins

Runtime plugins add upstream provider types, generation hooks, management routes,
and optional dashboard pages without rebuilding or restarting LLMHub. Start with
`examples/plugins/echo.mjs` (a network-free streaming provider) or
`examples/plugins/system-prompt.mjs` (a configurable request hook).

## Trust model

**Install only code you trust.** Plugins execute inside the gateway process with
its full Node.js and filesystem permissions. This is not a sandbox. Even uploading
a single-file plugin executes its top-level module code to read its manifest;
installation is a code-execution trust decision, not merely a file upload.
Plugins must not import gateway build internals. Use the injected API, Node built-in
modules, and files shipped in the plugin directory. No package installation is
performed. Dashboard authentication protects management endpoints, but does not
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
`index.mjs` and must be an `.mjs` file. Paths are relative to the plugin directory;
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

Register providers, hooks, routes, and config listeners during `setup`, including
its awaited work. Registration closes when setup finishes or times out. Supply
**local** provider/hook IDs matching `[a-z0-9][a-z0-9-]{0,63}`: the loader always
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
  createAdapter(configuration: ProviderConfig): ProviderAdapter
  fetchModels(configuration: ProviderConfig,
    context: { fetcher(url: string, options?: RequestInit): Promise<Response> }
  ): Promise<ModelInfo[]>
  secretConnectionFields: readonly string[]
  requiresRefreshToken?: boolean
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
Built-in provider configuration and login flows remain unchanged.

`fetchModels` returns namespaced IDs such as `<providerName>/echo`; its helper
fetcher has a ten-second timeout and one retry. Custom model catalogs still work.
Streaming adapters supply UTF-8 SSE `data:` lines containing upstream JSON;
`fromProviderStreamChunk` converts each parsed object to unified chunks. The
pipeline recognizes `data: [DONE]`. The echo example demonstrates content, final
usage, and finish chunks without network access. See `server/core/types.ts` for
unified messages, tool calls, reasoning, embedding, and usage structures.

### Hooks

```ts
interface RequestHook {
  id: string
  priority?: number
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

Lower priorities run first; ties retain registration order. `undefined` preserves
the value, stream `null` or `[]` drops a chunk, and arrays expand a chunk. Request
hook exceptions abort forwarding. Other hook exceptions are logged and processing
continues. Return replacements instead of mutating inputs before throwing.
Hooks cover generation, not embeddings. This stage adds no per-chunk plugin
wrapper or registry to the existing pipeline; with no plugins its hook dispatch
cost is unchanged from the first-stage pipeline.
See [Request pipeline](request-pipeline.md) for protocol-specific boundaries.

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

ESM modules cannot truly be unloaded. Repeated reloads retain module instances;
relative imported helper modules use Node's normal cache, so entry cache busting
does not recursively refresh unchanged helper URLs. For helper upgrades use
versioned filenames/import URLs (or bundle into the entry). Avoid side effects at
module top level, especially because single-file validation imports from a
staging directory before activation. Timeout bounds asynchronous waits, not CPU
execution: a synchronous infinite loop blocks the shared process. Timed-out
promises cannot be cancelled; late API registration/storage access is rejected,
but arbitrary external side effects are not reversible. These are consequences
of the trusted, in-process design, not security isolation guarantees.

## Management endpoints

All paths below require the existing dashboard session:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/hub/plugins` | Records, manifests, statuses, errors, provider/hook IDs |
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

Tests in `tests/plugins.test.ts` and `tests/plugin-provider.test.ts` cover runtime
and credential boundaries. `tests/e2e/plugins.test.mjs` installs both examples,
checks OpenAI/Claude/Gemini streaming and non-streaming calls, verifies hook
removal, reload, disabled-provider behavior, and built-in health, then removes its
fixtures. Run the normal acceptance sequence: `npx vue-tsc --noEmit`, `npm test`,
`npm run build`, and `npm run test:e2e`.
