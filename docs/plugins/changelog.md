# Plugin API changelog

Changes to the API that plugins are written against. This version is separate
from LLMHub's own: a plugin declares the range it supports in
`engines.llmhub`. See [Versioning](reference.md#versioning).

## 1.3.0

**Added**

- Automatic generic subscription usage panels for every provider type declaring
  `subscriptionUsage`, including runtime providers; provider type responses expose
  boolean usage and reset capabilities.
- `provider` panels with `providerType` targeting the declaring plugin's own
  provider type, shown on each provider card alongside the generic usage panel.
- Read-only provider identifiers in the panel client context and requests to open
  HTTPS links through a host-rendered confirmation. No credentials enter context
  and no external link opens without a user click.

**Compatibility**

Plugins written for 1.0–1.2 work unchanged. Declare `"llmhub": "^1.3.0"` when
using provider panels, context or external-link requests.

## 1.2.0

`onComplete` is now the one place to learn that a request finished.

**Changed**

- `onComplete` runs exactly once for every admitted request: generation and
  embeddings, streaming or not, successful or failed.
- Its argument gains `model`, the model that actually handled the request.
- For a streamed response, `usage` is the final figure. Usage updates sent
  mid-stream are no longer reported separately.
- It runs after the response, in the background. An error in it is logged and
  does not affect the request.

**Removed**

- `onAccountingComplete` and the `AccountingCompletion` type. Use `onComplete`.
  This hook was never part of a released API, so the major version is
  unchanged.

**Compatibility**

Plugins written for 1.0 or 1.1 work unchanged. Declare `"llmhub": "^1.2.0"` if
you read `completion.model` or rely on `onComplete` firing for embeddings.

## 1.1.0

Plugins can extend the dashboard.

**Added**

- Manifest: `llmhub.contributes` with `models`, `apiKeys`, `providers`,
  `metrics`, `panels` and `navigation`. See
  [Dashboard contributions](reference.md#dashboard-contributions).
- `api.getRecordValues`, `api.getAllRecordValues` and
  `api.onRecordValuesChange`, for reading the values users enter in contributed
  fields.
- `api.registerMetric`, for home-page metric cards.
- [Panels](reference.md#panels): sandboxed pages on the home page, the plugin's
  detail page, or as standalone pages, with a `window.llmhub` helper that calls
  the plugin's own management routes.

**Compatibility**

Plugins written for 1.0 work unchanged. Declare `"llmhub": "^1.1.0"` if you use
anything above.

## 1.0.0

The first versioned plugin API.

- `setup(api)` entry point with an optional cleanup function.
- `package.json` manifest with an `llmhub` block; `plugin.json` still read.
- `engines.llmhub` compatibility check, enforced before plugin code runs.
- `api.registerHook` with admission, model-list, generation and accounting
  stages.
- `api.registerProvider`, `api.registerProtocol`, `api.registerIngress`.
- `api.registerRoute` for management endpoints.
- `api.config`, `api.onConfigChange`, `api.storage`, `api.logger`.
- Plugin dependencies (`llmhub.dependencies`, `llmhub.optionalDependencies`)
  with `api.provide` and `api.require`.
- Installation from npm and GitHub, with npm library dependencies.
