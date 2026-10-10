import { getHeader } from 'h3'
import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { getAuthStore } from '../../server/stores/auth.store'
import { checkRateLimit } from './service'

export default {
  setup(api: PluginAPI) {
    api.registerHook({
      id: 'requests',
      async onBeforeIdentity({ event }) {
        const configuration = await getAuthStore().getBruteForceConfig()
        let clientIP = event.context?.clientAddress || '127.0.0.1'
        if (configuration.ip_header) {
          const header = getHeader(event, configuration.ip_header)
          if (header) clientIP = header.split(',')[0].trim()
        }
        const result = await checkRateLimit(clientIP, configuration)
        if (!result.allowed) return {
          status: 429, message: `Rate limit exceeded. Retry after ${result.retryAfter}s.`, code: 'rate_limit_exceeded'
        }
      }
    })
  }
}
