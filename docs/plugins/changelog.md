# Plugin API changelog

Changes to the API that plugins are written against. This version is separate
from LLMHub's own: a plugin declares the range it supports in
`engines.llmhub`. See [Versioning](reference.md#versioning).

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
