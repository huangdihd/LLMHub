# Plugins

Plugins extend LLMHub without forking it. A plugin can:

- add an upstream provider type;
- change requests and responses as they pass through the gateway, or reject them;
- store per-model, per-key and per-provider settings and act on them;
- add management endpoints, dashboard fields, metric cards and its own pages.

Plugins install from the market, from a GitHub repository, or from a folder on
disk, and can be enabled, updated and removed while the gateway is running.

**A plugin is code running inside the gateway with the gateway's full
privileges.** Install only plugins you trust. See
[Security](reference.md#security).

## Where to start

| You want to | Read |
| --- | --- |
| Write your first plugin | [Getting started](getting-started.md) |
| Look up a manifest field, an API method or a hook | [Reference](reference.md) |
| Work on LLMHub's own built-in plugins | [Built-in plugins](builtin.md) |
| See what changed between plugin API versions | [Changelog](changelog.md) |

Working examples live in [`examples/plugins/`](../../examples/plugins):

| Example | Shows |
| --- | --- |
| `system-prompt/` | A request hook with configuration and a management route |
| `echo/` | An upstream provider that needs no network, with streaming |
| `text-service/`, `text-consumer/` | One plugin exposing an interface that another depends on |
| `package-service/` | A plugin that imports an npm library |
| `dashboard-contributions/` | Dashboard fields, a metric, a panel and a navigation entry |

`examples/plugins/llmhub-plugin.d.ts` contains TypeScript declarations for the
whole plugin API. Copy it next to your plugin for editor completion.
