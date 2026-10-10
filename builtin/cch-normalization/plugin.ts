import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { getProviderStore } from '../../server/stores/provider.store'

export default {
  setup(api: PluginAPI) {
    api.registerHook({
      id: 'normalize',
      // Late, so the prompt is rewritten after other request hooks have shaped it.
      priority: 1000,
      async onRequest(request, context) {
        if (context.incomingProtocol !== 'claude-messages' || !context.providerName || !request.config.systemPrompt) return
        const configuration = await getProviderStore().get(context.providerName)
        if (!configuration?.normalize_cch) return
        return {
          ...request,
          config: { ...request.config, systemPrompt: request.config.systemPrompt.replace(/;\s*cch=\w+;/g, '; cch=00000;') }
        }
      }
    })
  }
}
