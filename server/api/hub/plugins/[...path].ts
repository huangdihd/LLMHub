import { createError, defineEventHandler, getMethod, getRouterParam, readBody, readMultipartFormData, setHeader } from 'h3'
import { readFile } from 'node:fs/promises'
import type { H3Event } from 'h3'
import { getPluginManager, PluginError } from '../../../plugins-runtime'

const MAX_UPLOAD_BYTES = 1024 * 1024
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
  if (path.length === 1 && id === 'scan' && method === 'POST') return manager.scan()
  if (path.length === 1 && id === 'install' && method === 'POST') {
    const length = Number(event.node.req.headers['content-length'])
    if (!Number.isFinite(length) || length > MAX_UPLOAD_BYTES + 16_384) {
      throw createError({ statusCode: 413, message: 'Plugin upload limit is 1 MiB; Content-Length is required' })
    }
    const parts = await readMultipartFormData(event)
    const file = parts?.find(part => part.name === 'file' && part.filename)
    if (!file || !file.filename?.endsWith('.mjs')) throw createError({ statusCode: 400, message: 'Upload one .mjs plugin as file' })
    if (file.data.length > MAX_UPLOAD_BYTES) throw createError({ statusCode: 413, message: 'Plugin upload limit is 1 MiB' })
    const forceParts = parts?.filter(part => part.name === 'force') ?? []
    // Only the literal multipart field force=true opts into version replacement.
    // Do not coerce arbitrary strings (notably "false") to a truthy boolean.
    if (forceParts.length > 1 || forceParts.some(part => part.filename || !['true', 'false'].includes(part.data.toString('utf8')))) {
      throw createError({ statusCode: 400, message: 'force must be a single text field containing true or false' })
    }
    const force = forceParts[0]?.data.toString('utf8') === 'true'
    return manager.install(file.data, force)
  }
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
  if (action === 'config' && method === 'GET') return manager.getConfig(id)
  if (action === 'config' && method === 'PUT') return manager.updateConfig(id, await readBody(event))
  if (method === 'POST') {
    if (action === 'enable') return manager.enable(id)
    if (action === 'disable') return manager.disable(id)
    if (action === 'reload') return manager.reload(id)
  }
  throw createError({ statusCode: 404, message: 'Plugin endpoint not found' })
}
