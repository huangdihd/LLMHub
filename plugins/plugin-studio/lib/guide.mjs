import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Full documentation ships with source installations; Docker images contain only
 * the build. The short guide below is always available.
 */
export const DOCUMENTS = {
  reference: 'docs/plugins/reference.md',
  'getting-started': 'docs/plugins/getting-started.md',
  types: 'examples/plugins/llmhub-plugin.d.ts'
}

export async function readDocument(name, root = process.cwd()) {
  const path = DOCUMENTS[name]
  if (!path) throw new Error(`Unknown document. Choose one of: ${Object.keys(DOCUMENTS).join(', ')}`)
  try { return await readFile(join(root, path), 'utf8') }
  catch { return `${path} is not available on this installation. Rely on the guide in your instructions.` }
}

export const GUIDE = `
LLMHub runtime plugins are ESM npm packages loaded in-process by the gateway.

package.json:
- name, version (semver), "type": "module", "main": "index.mjs", "keywords": ["llmhub-plugin"],
  "engines": { "llmhub": "^1.4.0" }
- "llmhub": { "id": "<must equal the folder name>", "name": "Display name",
  "configSchema": [PluginField], "contributes": { models, apiKeys, providers, metrics, panels, navigation } }
- PluginField: { key: /[a-zA-Z][a-zA-Z0-9_]*/, label, type: 'text'|'secret'|'number'|'boolean'|'select',
  multiline?, required?, default?, options? }. Secrets cannot have a default; select needs options.

index.mjs default export: { setup(api) } — may be async, may return a cleanup function.
Register everything during setup; later register*/on* calls are rejected.

api.config (read-only settings snapshot), api.onConfigChange(listener)
api.registerHook({ id, priority?, onRequest?(request, context), onResponse?(response, context),
  onStreamChunk?(chunk, context), onModels?(models, context),
  onBeforeIdentity?/onAfterIdentity?/onModelResolved?(admissionContext) })
  - onRequest returns a new LLMRequest, or { response: string | LLMResponse } to answer without an upstream, or nothing.
  - LLMRequest: { model, messages: [{ role, content: string | ContentBlock[] }], config: { systemPrompt?, temperature?, maxTokens?, ... }, tools?, stream? }
  - Never mutate the incoming request; return a copy.
  - Admission hooks return { status, message, code } to reject.
api.registerProvider(definition) — upstream provider types (see the reference document).
api.registerRoute(method, path, handler) serves /api/hub/plugins/<id>/api/<path>; exact path, returns JSON.
  Handlers have about 5 seconds; start long work in the background and poll it.
api.registerMetric(key, getter) for a declared metrics entry.
api.getRecordValues(location, recordId) / getAllRecordValues / onRecordValuesChange for declared contributed fields.
api.onEvent('llmhub:request-complete' | 'llmhub:request-error' | 'llmhub:models-refreshed', listener)
api.storage.getItem/setItem/removeItem (keys: letters, digits, _ and -, separated by /)
api.logger.info/warn/error, api.provide(object), api.require(pluginId)

Panels ("contributes.panels": [{ id, title, location: 'home'|'detail'|'page'|'provider', page: 'ui/x.html' }],
navigation: [{ panel, label, icon? }]): one self-contained HTML file in a sandboxed frame. Inline CSS and JS only;
no network. window.llmhub.fetch(path, { method, body }) calls this plugin's own routes and resolves to JSON.
Use llmhub.theme and :root[data-theme="dark"] for dark mode. Insert data with textContent, never innerHTML.

Never log or return credentials (hook contexts and provider configurations contain them). Validate route input.
`.trim()

export function systemPrompt(project, files) {
  return `You are the assistant inside LLMHub Plugin Studio. You help the user build the LLMHub plugin "${project}",
whose folder is the plugin directory LLMHub scans. You can only see and change files in this folder, using the tools.

Work like a careful engineer: read files before changing them, keep changes focused, prefer edit_file for small
changes, and finish by running check_project. Explain briefly what you changed and how to try it
(Plugins → Scan or Reload, then Enable). Reply in the language the user writes in.

Current files:
${files.map(file => `- ${file.path} (${file.size} bytes)`).join('\n') || '(none)'}

Plugin authoring guide:
${GUIDE}

For details call read_docs with "reference", "getting-started" or "types".`
}
