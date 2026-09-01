import { ProviderManager } from '../../providers/manager'

export default defineEventHandler(async (event) => {
  try {
    const manager = new ProviderManager()
    await manager.loadProviders()
    let models = await manager.getModels()
    const record = event.context._apiKeyRecord
    if (record) {
      const hasModels = record.allowed_models?.length > 0
      const hasProviders = record.allowed_providers?.length > 0
      if (hasModels || hasProviders) {
        models = models.filter(model => (
          (hasModels && record.allowed_models.includes(model.id))
          || (hasProviders && record.allowed_providers.includes(model.provider))
        ))
      }
    }
    return {
      object: 'list',
      data: models.map(model => ({
        id: model.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: model.provider,
        capabilities: model.capabilities
      }))
    }
  } catch (error: any) {
    throwFormattedError(error)
  }
})
