import { ProviderManager } from '../../../providers/manager'

export default defineEventHandler(async (event) => {
  try {
    const manager = new ProviderManager()
    await manager.loadProviders()

    let models = await manager.getModels()

    // Filter based on API Key restrictions
    const record = event.context._apiKeyRecord
    if (record) {
      const hasModels = record.allowed_models?.length > 0
      const hasProviders = record.allowed_providers?.length > 0

      if (hasModels || hasProviders) {
        models = models.filter(m => {
          if (hasModels && record.allowed_models.includes(m.id)) return true
          if (hasProviders && record.allowed_providers.includes(m.provider)) return true
          return false
        })
      }
    }

    // Include fallback virtual model if key has fallback enabled
    if (record?.fallback_strategy?.enabled) {
      const fallbackName = record.fallback_strategy.name || 'auto'
      const existing = models.find(m => m.id === fallbackName)
      if (!existing) {
        models.unshift({
          id: fallbackName,
          provider: 'fallback',
          name: fallbackName,
          display_name: `Auto (${record.fallback_strategy.priority.length} models)`,
          capabilities: { tools: true, vision: true, streaming: true }
        })
      }
    }

    // Anthropic list format: type:'model', created_at, has_more / first_id / last_id
    const data = models.map(m => ({
      type: 'model',
      id: m.id,
      display_name: m.display_name,
      created_at: new Date().toISOString()
    }))

    return {
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null
    }
  } catch (error: any) {
    throwFormattedError(error)
  }
})
