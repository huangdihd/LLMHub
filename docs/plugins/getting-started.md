# Getting started

This walks through writing a plugin from an empty folder: a hook that adds an
instruction to every request, then configuration, a management endpoint, and
how to share the result. It takes about ten minutes.

You need a running LLMHub you can log in to, and access to its working
directory.

## 1. Create the plugin

Plugins on disk live in `.data/plugins/<id>/`, relative to the directory LLMHub
runs from. The folder name is the plugin's ID. Create `.data/plugins/hello/`
with two files.

`package.json` describes the plugin:

```json
{
  "name": "llmhub-plugin-hello",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs",
  "engines": { "llmhub": "^1.0.0" },
  "llmhub": {
    "id": "hello",
    "name": "Hello"
  }
}
```

`engines.llmhub` says which version of the plugin API you wrote against. The
`llmhub` block is what makes this package a plugin.

`index.mjs` is the code. It exports a `setup` function that receives the plugin
API:

```js
export default {
  setup(api) {
    api.registerHook({
      id: 'greet',
      onRequest(request) {
        return {
          ...request,
          config: { ...request.config, systemPrompt: 'Start every reply with "Hello!"' }
        }
      }
    })
  }
}
```

`onRequest` runs for every generation request after it has been converted to
LLMHub's unified format, whichever client protocol it arrived in. Returning a
new request replaces it; returning nothing leaves it unchanged.

## 2. Load and enable it

Open **Plugins** in the dashboard and click the rescan button (the circular
arrows, top right). **Hello** appears under *Installed*, disabled. Click
**Enable**.

Open **Chat**, pick any model and send a message. The reply starts with
"Hello!".

New plugins always start disabled, so nothing runs until you say so.

## 3. Pick up changes

After editing a plugin's files, open its **⋯** menu on the Plugins page and
choose **Reload**. Bumping `version` and rescanning has the same effect.

If `setup` throws, or takes longer than five seconds, the plugin is marked with
an error and everything it registered is rolled back. Other plugins and the
gateway are unaffected.

## 4. Add configuration

Declare the settings you need and LLMHub renders the form. Add a
`configSchema` to the `llmhub` block:

```json
"llmhub": {
  "id": "hello",
  "name": "Hello",
  "configSchema": [
    { "key": "greeting", "label": "Greeting", "type": "text", "default": "Hello!" },
    { "key": "enabled", "label": "Add the greeting", "type": "boolean", "default": true }
  ]
}
```

Read the current values from `api.config`:

```js
onRequest(request) {
  if (!api.config.enabled) return
  return {
    ...request,
    config: { ...request.config, systemPrompt: `Start every reply with "${api.config.greeting}"` }
  }
}
```

Reload the plugin, then click **Configure** on its card. Read `api.config` when
you need a value rather than copying it during `setup`, so that changes made in
the dashboard take effect immediately.

Field types are `text`, `secret`, `number`, `boolean` and `select`. A `secret`
is never sent back to the browser once saved.

## 5. Add a management endpoint

```js
let count = 0
// inside onRequest: count++

api.registerRoute('GET', 'status', () => ({ requests: count }))
```

After a reload, this answers at `/api/hub/plugins/hello/api/status`. Plugin
routes always live under the plugin's own prefix and require a dashboard
login, the same as the rest of the management API. They are not reachable with
a client API key.

## 6. Get editor help

Copy `examples/plugins/llmhub-plugin.d.ts` next to your plugin and annotate
`setup`:

```js
export default {
  /** @param {import('./llmhub-plugin').PluginAPI} api */
  setup(api) {
    // ...
  }
}
```

Your editor now completes API methods and checks hook signatures.

## 7. Clean up after yourself

If the plugin starts timers, opens connections or holds other resources,
return a function from `setup`. It runs when the plugin is disabled, reloaded
or removed:

```js
setup(api) {
  const timer = setInterval(flush, 60_000)
  return () => clearInterval(timer)
}
```

Hooks, routes and everything else registered through `api` are removed for
you.

## Where to go next

- **Reject or route requests.** Hooks such as `onModelResolved` run before the
  request body is parsed and can refuse a request with a status code or send it
  to a different model. See [Hooks](reference.md#hooks).
- **Add an upstream.** `examples/plugins/echo/` is a complete provider in about
  forty lines. See [Providers](reference.md#providers).
- **Extend the dashboard.** Attach your own fields to models, API keys and
  providers, show a metric on the home page, or ship a page of your own. See
  [Dashboard contributions](reference.md#dashboard-contributions).
- **Use an npm library.** Add it to `dependencies` in `package.json`. See
  [Libraries](reference.md#libraries).
- **Build on another plugin.** See
  [Depending on other plugins](reference.md#depending-on-other-plugins).

## Sharing a plugin

A plugin folder is an ordinary npm package, so there are two ways to
distribute it.

**Publish to npm.** Add `"keywords": ["llmhub-plugin"]` to `package.json` and
run `npm publish`. The plugin then shows up in every LLMHub's plugin market,
where it can be installed and updated with a click. By convention the package
is named `llmhub-plugin-<id>`; the ID is then taken from the name and
`llmhub.id` can be omitted.

**Push to GitHub.** Anyone can install it with **Install from GitHub** on the
Plugins page, by `owner/repo` and optionally a tag, branch or commit. Tag
releases with their version number (`v1.2.0`) so LLMHub can offer updates.

Either way, the published package must be ready to load: LLMHub never runs
install or build scripts, so commit or publish the built JavaScript, not only
its sources.
