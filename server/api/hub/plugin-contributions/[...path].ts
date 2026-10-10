import { createError, defineEventHandler, getMethod, getRouterParam, readBody } from 'h3'
import { getPluginManager, PluginError } from '../../../plugins-runtime'
import type { PluginRecordLocation } from '../../../../shared/types/plugin'

export default defineEventHandler(async event => {
  // Split before decoding: model IDs contain an encoded slash, unlike route separators.
  const parts = (getRouterParam(event, 'path') ?? '').split('/')
  if (parts.length !== 3 || parts.some(part => !part)) throw createError({ statusCode: 404 })
  let decoded: string[]
  try { decoded = parts.map(part => decodeURIComponent(part)) }
  catch { throw createError({ statusCode: 400, message: 'Invalid contribution path' }) }
  const [pluginId, location, recordId] = decoded as [string, PluginRecordLocation, string]
  const manager = getPluginManager()
  try {
    const method = getMethod(event)
    if (method === 'GET') return await manager.getRecordValues(pluginId, location, recordId)
    if (method === 'PUT') return await manager.updateRecordValues(pluginId, location, recordId, await readBody(event))
    throw createError({ statusCode: 405, message: 'Method not allowed' })
  } catch (error) {
    if (error instanceof PluginError) throw createError({ statusCode: /not found/i.test(error.message) ? 404 : 400, message: error.message })
    throw error
  }
})
