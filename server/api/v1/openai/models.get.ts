import { ProviderManager } from '../../../providers/manager'

export default defineEventHandler(async (event) => {
  try {
    const manager = new ProviderManager()
    await manager.loadProviders()

    const models = await manager.getModels()

    return {
      object: 'list',
      data: models.map(m => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: m.provider,
        capabilities: m.capabilities
      }))
    }
  } catch (error: any) {
    throwFormattedError(error)
  }
})
