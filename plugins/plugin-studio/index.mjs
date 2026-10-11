/** @typedef {import('../../examples/plugins/llmhub-plugin').PluginAPI} PluginAPI */
import { copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CONTINUE_EXTENSION, writeContinueConfig } from './lib/continue.mjs'
import { TEMPLATES } from './lib/templates.mjs'
import { findCommand, VSCodeServer } from './lib/vscode.mjs'
import { validateProjectId, Workspace, WorkspaceError } from './lib/workspace.mjs'

export const PLUGIN_ID = 'plugin-studio'
const MAX_BODY_BYTES = 64 * 1024
const MAX_MODELS = 50

async function readJson(event) {
  const chunks = []
  let size = 0
  for await (const chunk of event.node.req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new WorkspaceError('Request body is too large')
    chunks.push(chunk)
  }
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }
  catch { throw new WorkspaceError('Request body is not JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkspaceError('Expected a JSON object')
  return body
}

export function gatewayUrl(config, env = process.env) {
  return String(config.gatewayUrl || '').trim().replace(/\/+$/, '') || `http://127.0.0.1:${env.PORT || env.NITRO_PORT || 3000}/api/openai`
}

/** The models this API key may use, with the configured one first. */
export async function listModels(url, apiKey, preferred = '') {
  const response = await fetch(`${url}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`Could not list models with the configured API key (${response.status})`)
  const ids = ((await response.json()).data || []).map(model => String(model.id)).sort()
  if (preferred) ids.splice(0, ids.length, preferred, ...ids.filter(id => id !== preferred))
  return ids.slice(0, MAX_MODELS)
}

export default {
  /** @param {PluginAPI} api */
  async setup(api) {
    const root = () => resolve(String(api.config.workspace || '').trim() || join(process.cwd(), '.data/plugins'))
    const workspace = () => new Workspace(root(), PLUGIN_ID)
    // Outside the plugin folder, so the gateway never scans it as a plugin.
    const continueDirectory = () => resolve(root(), '..', 'plugin-studio', 'continue')
    const vscode = new VSCodeServer(api.logger)

    api.registerRoute('GET', 'overview', async () => ({
      workspace: root(),
      projects: await workspace().projects(),
      templates: Object.entries(TEMPLATES).map(([id, template]) => ({ id, label: template.label, description: template.description })),
      apiKey: Boolean(api.config.apiKey)
    }))

    api.registerRoute('POST', 'projects', async event => {
      const { id, name, template = 'hook' } = await readJson(event)
      validateProjectId(id)
      if (!Object.hasOwn(TEMPLATES, template)) throw new WorkspaceError('Unknown template')
      await workspace().create(id, TEMPLATES[template].files(id, String(name || '').trim().slice(0, 100) || id))
      // Editor completion for `@typedef {import('./llmhub-plugin')}`, when the source tree is present.
      await copyFile(join(process.cwd(), 'examples/plugins/llmhub-plugin.d.ts'), join(root(), id, 'llmhub-plugin.d.ts')).catch(() => {})
      return { project: await workspace().describe(id) }
    })

    api.registerRoute('GET', 'vscode', async () => ({
      ...vscode.status(),
      command: await findCommand(String(api.config.vscodeCommand || '').trim())
    }))
    api.registerRoute('POST', 'vscode/start', async event => {
      const { project } = await readJson(event)
      const command = await findCommand(String(api.config.vscodeCommand || '').trim())
      if (!command) throw new WorkspaceError('No VS Code server found. Install openvscode-server or code-server, or set its path in Plugin Studio settings.')
      const folder = project ? workspace().directory(project) : root()
      const current = vscode.status()
      if (current.running && current.folder !== folder) vscode.stop()
      const apiKey = String(api.config.apiKey || '')
      const assistant = api.config.assistant !== false
      return vscode.start({
        command, folder,
        host: String(api.config.vscodeHost || '127.0.0.1'),
        port: Math.floor(Number(api.config.vscodePort) || 3100),
        publicUrl: String(api.config.vscodePublicUrl || '').trim() || undefined,
        extension: assistant ? CONTINUE_EXTENSION : undefined,
        env: assistant ? { CONTINUE_GLOBAL_DIR: continueDirectory() } : {},
        prepare: assistant ? async () => {
          if (!apiKey) return 'Set an LLMHub API key in Plugin Studio settings so Continue can use this gateway\'s models.'
          const url = gatewayUrl(api.config)
          const models = await listModels(url, apiKey, String(api.config.model || '').trim())
          await writeContinueConfig(continueDirectory(), { models, apiBase: url, apiKey })
          if (!models.length) return 'The API key has no models available.'
        } : undefined
      })
    })
    api.registerRoute('POST', 'vscode/stop', () => vscode.stop())

    return () => { vscode.stop() }
  }
}
