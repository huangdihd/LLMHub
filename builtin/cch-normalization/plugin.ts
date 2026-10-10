import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { getProviderStore } from '../../server/stores/provider.store'

export default {
  setup(api: PluginAPI) {
    api.registerHook({
      id: 'normalize',
      async onNormalize(request, context) {
        if (context.incomingProtocol !== 'claude-messages' || !context.providerName || !request.config.systemPrompt) return
        // Keep the fresh store lookup after the Claude request log.
        const configuration = await getProviderStore().get(context.providerName)
        if (configuration?.normalize_cch) {
          request.config.systemPrompt = request.config.systemPrompt.replace(/;\s*cch=\w+;/g, '; cch=00000;')
        }
      }
    })
  }
}
