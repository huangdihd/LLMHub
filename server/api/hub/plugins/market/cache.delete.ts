import { defineEventHandler } from 'h3'
import { getPluginManager } from '../../../../plugins-runtime'
import { getPluginMarket } from '../../../../plugins-runtime/market'
import { getAuthStore } from '../../../../stores/auth.store'

export default defineEventHandler(() => getPluginMarket({
  manager: getPluginManager(), getSSRFConfig: () => getAuthStore().getSSRFConfig()
}).clearCache())
