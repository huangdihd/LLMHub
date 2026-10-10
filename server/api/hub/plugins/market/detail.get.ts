import { createError, defineEventHandler, getQuery } from 'h3'
import { getPluginManager } from '../../../../plugins-runtime'
import { getPluginMarket, PluginMarketError } from '../../../../plugins-runtime/market'
import { getAuthStore } from '../../../../stores/auth.store'

export default defineEventHandler(async event => {
  try {
    return await getPluginMarket({ manager: getPluginManager(), getSSRFConfig: () => getAuthStore().getSSRFConfig() }).detail(getQuery(event).name as string)
  } catch (error) {
    if (error instanceof PluginMarketError) throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code } })
    throw error
  }
})
