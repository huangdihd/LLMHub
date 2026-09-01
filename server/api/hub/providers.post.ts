import type { ProviderConfig } from '../../core/types'
import { getProviderStore } from '../../stores/provider.store'
import { getAuthStore } from '../../stores/auth.store'
import { ProviderLoader } from '../../providers/loader'
import { validateBaseUrl } from '../../utils/validate-url'

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    const store = getProviderStore()

    if (!body.name) {
      throw createError({ statusCode: 400, message: 'Provider name is required' })
    }

    if (body.protocol === 'codex-subscription' && !body.device_id?.trim()) {
      throw createError({ statusCode: 400, message: 'Device ID is required for Codex Subscription providers' })
    }

    if (body.base_url) {
      const ssrfConfig = await getAuthStore().getSSRFConfig()
      const result = validateBaseUrl(body.base_url, ssrfConfig)
      if (!result.valid) {
        throw createError({ statusCode: 400, message: `Invalid base URL: ${result.reason}` })
      }
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
        enable_timeout: body.enable_timeout ?? true,
        max_retries: body.max_retries || 3,
        version: body.version || '',
        device_id: body.device_id?.trim() || undefined,
        account_id: body.account_id?.trim() || undefined
      },
      models: body.models || [],
      defaults: body.defaults || { temperature: 0.7, max_tokens: 4096 },
      ...(body.normalize_cch !== undefined ? { normalize_cch: body.normalize_cch } : {})
    }

    const provider = await store.create(newProvider)
    ProviderLoader.invalidateCache()
    return { success: true, provider: store.sanitize(provider) }
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
