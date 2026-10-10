import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { resolveFallbackModel } from './service'

export default {
  setup(api: PluginAPI) {
    api.registerHook({
      id: 'resolve', priority: -300,
      onModelResolved(context) {
        const record = context.apiKeyRecord!
        if (!record.fallback_strategy?.enabled || context.model !== record.fallback_strategy.name) return
        const result = resolveFallbackModel(record)
        if (result.exhausted) return { status: 429, message: 'All fallback models exhausted.', code: 'fallback_exhausted' }
        if (result.resolved) context.model = result.resolved
      }
    })
    api.registerHook({
      id: 'catalog', priority: 100,
      onModels(models, context) {
        const strategy = context.apiKeyRecord?.fallback_strategy
        if (!strategy?.enabled) return
        const name = strategy.name || 'auto'
        if (!models.find(model => model.id === name)) models.unshift({
          id: name, provider: 'fallback', name,
          display_name: `Auto (${strategy.priority.length} models)`,
          capabilities: { tools: true, vision: true, streaming: true }
        })
      }
    })
  }
}
