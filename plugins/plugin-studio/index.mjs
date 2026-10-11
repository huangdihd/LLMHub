/** @typedef {import('../../examples/plugins/llmhub-plugin').PluginAPI} PluginAPI */
import { copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Agent } from './lib/agent.mjs'
import { TEMPLATES } from './lib/templates.mjs'
import { findCommand, VSCodeServer } from './lib/vscode.mjs'
import { validateProjectId, Workspace, WorkspaceError } from './lib/workspace.mjs'

export const PLUGIN_ID = 'plugin-studio'
const MODEL_LIST_TIMEOUT = 4000
const MAX_BODY_BYTES = 1024 * 1024

/** Route bodies arrive as JSON objects; anything else is a mistake in the caller. */
const read = async event => {
  const body = await readJson(event)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkspaceError('Expected a JSON object')
  return body
}
async function readJson(event) {
  const chunks = []
  let size = 0
  for await (const chunk of event.node.req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new WorkspaceError('Request body is too large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }
  catch { throw new WorkspaceError('Request body is not JSON') }
}

/** The dashboard session of whoever is using the studio, so the assistant can call models as them. */
export function sessionCookie(event) {
  const header = event.node?.req?.headers?.cookie ?? ''
  const match = /(?:^|;\s*)llmhub_session=([^;]+)/.exec(header)
  return match ? match[1] : ''
}

export function gatewayEndpoint(config, event, env = process.env) {
  const configured = String(config.gatewayUrl || '').trim().replace(/\/+$/, '')
  const url = configured || `http://127.0.0.1:${env.PORT || env.NITRO_PORT || 3000}/api/openai`
  const apiKey = String(config.apiKey || '')
  if (apiKey) return { url, headers: { authorization: `Bearer ${apiKey}` } }
  const session = sessionCookie(event)
  if (!session) throw new WorkspaceError('Set an API key in Plugin Studio settings, or sign in to the dashboard')
  return { url, headers: { cookie: `llmhub_session=${session}` } }
}

export default {
  /** @param {PluginAPI} api */
  async setup(api) {
    const root = () => resolve(String(api.config.workspace || '').trim() || join(process.cwd(), '.data/plugins'))
    const workspace = () => new Workspace(root(), PLUGIN_ID)
    const agents = new Map()
    const vscode = new VSCodeServer(api.logger)

    const saveConversation = (project, messages) =>
      api.storage.setItem(`conversations/${project}`, messages).catch(error => api.logger.warn('Could not save the conversation', error))
    const agentFor = async project => {
      validateProjectId(project)
      let agent = agents.get(project)
      if (!agent) {
        const messages = (await api.storage.getItem(`conversations/${project}`)) || []
        agent = new Agent({ workspace: workspace(), project, messages, save: saveConversation })
        agents.set(project, agent)
      }
      return agent
    }

    api.registerRoute('GET', 'overview', async () => ({
      workspace: root(),
      projects: await workspace().projects(),
      templates: Object.entries(TEMPLATES).map(([id, template]) => ({ id, label: template.label, description: template.description })),
      model: String(api.config.model || ''),
      apiKey: Boolean(api.config.apiKey)
    }))

    api.registerRoute('POST', 'projects', async event => {
      const { id, name, template = 'hook' } = await read(event)
      validateProjectId(id)
      if (!Object.hasOwn(TEMPLATES, template)) throw new WorkspaceError('Unknown template')
      const displayName = String(name || '').trim().slice(0, 100) || id
      const files = TEMPLATES[template].files(id, displayName)
      await workspace().create(id, files)
      // Editor completion for `@typedef {import('./llmhub-plugin')}`, when the source tree is present.
      await copyFile(join(process.cwd(), 'examples/plugins/llmhub-plugin.d.ts'), join(root(), id, 'llmhub-plugin.d.ts')).catch(() => {})
      return { project: await workspace().manifest(id) }
    })

    api.registerRoute('POST', 'files/list', async event => {
      const { project } = await read(event)
      return { files: await workspace().list(project) }
    })
    api.registerRoute('POST', 'files/read', async event => {
      const { project, path } = await read(event)
      return { path, content: await workspace().read(project, path) }
    })
    api.registerRoute('POST', 'files/write', async event => {
      const { project, path, content } = await read(event)
      await workspace().write(project, path, content)
      return { saved: true }
    })
    api.registerRoute('POST', 'files/delete', async event => {
      const { project, path } = await read(event)
      await workspace().remove(project, path)
      return { deleted: true }
    })

    api.registerRoute('GET', 'models', async event => {
      const endpoint = gatewayEndpoint(api.config, event)
      const response = await fetch(`${endpoint.url}/models`, { headers: endpoint.headers, signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT) })
      if (!response.ok) throw new WorkspaceError(`Could not list models (${response.status})`)
      const data = await response.json()
      return { models: (data.data || []).map(model => String(model.id)).sort() }
    })

    api.registerRoute('POST', 'agent/run', async event => {
      const { project, prompt, model, file } = await read(event)
      if (typeof prompt !== 'string' || !prompt.trim()) throw new WorkspaceError('Write a message first')
      if (prompt.length > 20000) throw new WorkspaceError('The message is too long')
      const chosen = String(model || api.config.model || '').trim()
      if (!chosen) throw new WorkspaceError('Choose a model')
      const endpoint = gatewayEndpoint(api.config, event)
      const agent = await agentFor(project)
      if (agent.running) throw new WorkspaceError('The assistant is already working on this project')
      const maxSteps = Math.min(100, Math.max(1, Math.floor(Number(api.config.maxSteps) || 25)))
      // Runs past this request; the panel polls agent/status.
      agent.run({ prompt: prompt.trim(), model: chosen, endpoint, maxSteps, file: typeof file === 'string' ? file : undefined })
        .catch(error => api.logger.warn('The assistant failed', error))
      return agent.snapshot(Number.MAX_SAFE_INTEGER)
    })
    api.registerRoute('POST', 'agent/status', async event => {
      const { project, since = 0 } = await read(event)
      return (await agentFor(project)).snapshot(Number(since) || 0)
    })
    api.registerRoute('POST', 'agent/stop', async event => {
      const { project } = await read(event)
      ;(await agentFor(project)).stop()
      return { stopping: true }
    })
    api.registerRoute('POST', 'agent/clear', async event => {
      const { project } = await read(event)
      await (await agentFor(project)).clear()
      return { cleared: true }
    })

    api.registerRoute('GET', 'vscode', async () => ({
      ...vscode.status(),
      command: await findCommand(String(api.config.vscodeCommand || '').trim())
    }))
    api.registerRoute('POST', 'vscode/start', async event => {
      const { project } = await read(event)
      const command = await findCommand(String(api.config.vscodeCommand || '').trim())
      if (!command) throw new WorkspaceError('No VS Code server found. Install openvscode-server or code-server, or set its path in Plugin Studio settings.')
      const folder = project ? join(root(), validateProjectId(project)) : root()
      if (vscode.status().running && vscode.status().folder !== folder) vscode.stop()
      return vscode.start({
        command, folder,
        host: String(api.config.vscodeHost || '127.0.0.1'),
        port: Math.floor(Number(api.config.vscodePort) || 3100),
        publicUrl: String(api.config.vscodePublicUrl || '').trim() || undefined
      })
    })
    api.registerRoute('POST', 'vscode/stop', () => vscode.stop())

    return () => {
      for (const agent of agents.values()) agent.stop()
      vscode.stop()
    }
  }
}
