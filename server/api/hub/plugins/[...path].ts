import { createError, defineEventHandler, getMethod, getRouterParam, readBody, setHeader } from 'h3'
import { readFile } from 'node:fs/promises'
import type { H3Event } from 'h3'
import { getPluginManager, PluginError } from '../../../plugins-runtime'

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  json: 'application/json', woff2: 'font/woff2'
}

export default defineEventHandler(async event => {
  try {
    return await handle(event)
  } catch (error) {
    // Manager-authored messages are safe for administrators; anything else stays generic.
    if (error instanceof PluginError) {
      throw createError({ statusCode: /not found/i.test(error.message) ? 404 : 400, message: error.message })
    }
    throw error
  }
})

async function handle(event: H3Event) {
  const manager = getPluginManager()
  const path = (getRouterParam(event, 'path') || '').split('/').filter(Boolean)
  const method = getMethod(event)
  const [id, action, ...rest] = path
  if (path.length === 1 && id === 'capabilities' && method === 'GET') return manager.capabilities()
  if (path.length === 1 && id === 'sources' && method === 'GET') return manager.listSources()
  if (path.length === 1 && id === 'registry') {
    if (method === 'GET') return { registry: await manager.getRegistry() }
    if (method === 'PUT') {
      const body = await readBody(event)
      return { registry: await manager.setRegistry(body?.registry) }
    }
  }
  if (path.length === 1 && ['install-npm', 'install-github'].includes(id!) && method === 'POST') {
    const body = await readBody(event)
    if (body?.force !== undefined && typeof body.force !== 'boolean') throw new PluginError('force must be a boolean')
    return id === 'install-npm' ? manager.installNpm(body, body?.force) : manager.installGithub(body, body?.force)
  }
  if (path.length === 1 && id === 'scan' && method === 'POST') return manager.scan()
  if (!id) throw createError({ statusCode: 404 })
  if (action === 'api') return manager.dispatchRoute(id, method, rest.join('/'), event)
  if (action === 'page' && method === 'GET') {
    const filename = await manager.resolvePage(id, rest.join('/'))
    const extension = filename.split('.').pop()?.toLowerCase()
    setHeader(event, 'Content-Type', CONTENT_TYPES[extension || ''] || 'application/octet-stream')
    setHeader(event, 'X-Content-Type-Options', 'nosniff')
    setHeader(event, 'Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'")
    setHeader(event, 'Cache-Control', 'no-store')
    return readFile(filename)
  }
  if (rest.length) throw createError({ statusCode: 404 })
  if (!action && method === 'DELETE') return manager.uninstall(id)
  if (action === 'updates' && method === 'GET') return manager.updates(id)
  if (action === 'config' && method === 'GET') return manager.getConfig(id)
  if (action === 'config' && method === 'PUT') return manager.updateConfig(id, await readBody(event))
  if (method === 'POST') {
    if (action === 'update') {
      const body = await readBody(event)
      if (body?.force !== undefined && typeof body.force !== 'boolean') throw new PluginError('force must be a boolean')
      return manager.update(id, body?.specification, body?.force)
    }
    if (action === 'enable') return manager.enable(id)
    if (action === 'disable') return manager.disable(id)
    if (action === 'reload') return manager.reload(id)
  }
  throw createError({ statusCode: 404, message: 'Plugin endpoint not found' })
}
