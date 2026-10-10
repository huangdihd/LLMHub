import { applyThinkingPolicy } from '../services/thinking-policy'
import { getProviderStore } from '../stores/provider.store'
import { HookRegistry, requestHooks } from './hooks'

requestHooks.register({
  id: 'builtin:thinking-policy',
  priority: -100,
  onRequest(request, context) {
    if (context.incomingProtocol === 'gemini-generate') {
      return applyThinkingPolicy(request, request.model?.split('/')[0])
    }
    if (context.providerName && ['openai-chat', 'openai-responses', 'claude-messages'].includes(context.incomingProtocol)) {
      return applyThinkingPolicy(request, context.providerName)
    }
  }
})

// Claude historically normalizes after its request log and before formatting.
// Keep this built-in at that boundary rather than moving the log or store read.
export const normalizationHooks = new HookRegistry()
normalizationHooks.register({
  id: 'builtin:cch-normalization',
  onRequest: async (request, context) => {
    if (context.incomingProtocol !== 'claude-messages' || !context.providerName || !request.config.systemPrompt) return
    const configuration = await getProviderStore().get(context.providerName)
    if (configuration?.normalize_cch) {
      request.config.systemPrompt = request.config.systemPrompt.replace(/;\s*cch=\w+;/g, '; cch=00000;')
    }
  }
})
