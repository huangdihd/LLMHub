import { ProviderManager } from '../../../providers/manager'

export default defineEventHandler(async (event) => {
  try {
    const manager = new ProviderManager()
    await manager.loadProviders()

    let models = await manager.getModelsByProtocol('gemini')

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

    return {
      models: models.map(m => ({
        name: `models/${m.id}`,
        displayName: m.display_name || m.name,
        description: '',
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
        capabilities: m.capabilities
      }))
    }
  } catch (error: any) {
    throwFormattedError(error)
  }
})
