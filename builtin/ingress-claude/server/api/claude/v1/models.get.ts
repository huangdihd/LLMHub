import { requestHooks } from '../../../../../../server/core/hooks'
import { ProviderManager } from '../../../../../../server/providers/manager'

export default defineEventHandler(async (event) => {
  try {
    const manager = new ProviderManager()
    await manager.loadProviders()

    const models = await requestHooks.models(await manager.getModels(), {
      incomingProtocol: 'claude', apiKeyRecord: event.context._apiKeyRecord
    })

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
