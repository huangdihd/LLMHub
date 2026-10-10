import { createError, defineEventHandler, getRouterParam } from 'h3'
import { getPluginManager, PluginError } from '../../../../../plugins-runtime'
import { servePluginPanel } from '../../../../../utils/plugin-panel'

export default defineEventHandler(async event => {
  try {
    const filename = await getPluginManager().resolvePanel(getRouterParam(event, 'id') || '', getRouterParam(event, 'panelId') || '')
    return await servePluginPanel(event, filename)
  } catch (error) {
    if (error instanceof PluginError) throw createError({ statusCode: /not found/i.test(error.message) ? 404 : 400, message: error.message })
    throw error
  }
})
