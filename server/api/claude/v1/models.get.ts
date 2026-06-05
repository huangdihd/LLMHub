import { ProviderManager } from '../../../providers/manager'

export default defineEventHandler(async (event) => {
  try {
    const manager = new ProviderManager()
    await manager.loadProviders()

    let models = await manager.getModelsByProtocol('claude')

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

    return {
      object: 'list',
      data: models.map(m => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: m.provider,
        display_name: m.display_name,
        capabilities: m.capabilities
      }))
    }
  } catch (error: any) {
    throwFormattedError(error)
  }
})
