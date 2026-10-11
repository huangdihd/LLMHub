import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The Open VSX / Marketplace ID of Continue, the agent extension Plugin Studio sets up. */
export const CONTINUE_EXTENSION = 'Continue.continue'

/** Given to Continue as a rule, so its agent knows how LLMHub plugins are written. */
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

/**
 * Continue's configuration, pointing every model at this gateway. JSON strings are
 * valid YAML scalars, which keeps this free of a YAML dependency.
 */
export function continueConfig({ models, apiBase, apiKey }) {
  const quote = value => JSON.stringify(String(value))
  const lines = ['name: LLMHub', 'version: 1.0.0', 'schema: v1', 'models:']
  for (const model of models) {
    lines.push(
      `  - name: ${quote(model)}`, '    provider: openai', `    model: ${quote(model)}`,
      `    apiBase: ${quote(apiBase)}`, `    apiKey: ${quote(apiKey)}`,
      '    roles: [chat, edit, apply]', '    capabilities: [tool_use]'
    )
  }
  if (!models.length) lines.push('  []')
  lines.push('rules:', `  - ${quote(GUIDE)}`)
  return lines.join('\n') + '\n'
}

/** Continue reads its configuration from CONTINUE_GLOBAL_DIR, so the user's own ~/.continue is untouched. */
export async function writeContinueConfig(directory, options) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, 'config.yaml'), continueConfig(options), { mode: 0o600 })
}
