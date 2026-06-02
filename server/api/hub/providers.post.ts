import type { ProviderConfig } from '../../core/types'
import { getProviderStore } from '../../stores/provider.store'

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    const store = getProviderStore()

    if (!body.name) {
      throw createError({ statusCode: 400, message: 'Provider name is required' })
    }

    const newProvider: ProviderConfig = {
      name: body.name,
      display_name: body.display_name || body.name,
      protocol: body.protocol || 'openai',
      enabled: body.enabled !== false,
      use_custom_models: body.use_custom_models || false,
      connection: {
        api_key: body.api_key || '',
        base_url: body.base_url || '',
        timeout: body.timeout || 30000,
        max_retries: body.max_retries || 3,
        version: body.version
      },
      models: body.models || [],
      defaults: body.defaults || { temperature: 0.7, max_tokens: 4096 }
    }

    const provider = await store.create(newProvider)
    return { success: true, provider }
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
