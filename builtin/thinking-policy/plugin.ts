import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { applyThinkingPolicy } from './service'

export default {
  setup(api: PluginAPI) {
    api.registerHook({
      id: 'thinking', priority: -100,
      onRequest(request, context) {
        if (context.incomingProtocol === 'gemini-generate') {
          return applyThinkingPolicy(request, request.model?.split('/')[0])
        }
        if (context.providerName && ['openai-chat', 'openai-responses', 'claude-messages'].includes(context.incomingProtocol)) {
          return applyThinkingPolicy(request, context.providerName)
        }
      }
    })
  }
}
