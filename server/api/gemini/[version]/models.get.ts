import { requestHooks } from '../../../core/hooks'
import { ProviderManager } from '../../../providers/manager'

export default defineEventHandler(async (event) => {
  try {
    const manager = new ProviderManager()
    await manager.loadProviders()

    const models = await requestHooks.models(await manager.getModels(), {
      incomingProtocol: 'gemini', apiKeyRecord: event.context._apiKeyRecord
    })

    return {
      models: models.map(m => ({
        name: `models/${encodeURIComponent(m.id)}`,
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
