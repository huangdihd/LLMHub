import { providerRegistry } from '../../core/registry'
import type { ProviderConfig } from '../../core/types'
import { getProviderStore, acceptsProviderExtra, validatePluginConnectionExtra, validateProviderApiType, validateRegisteredProvider } from '../../stores/provider.store'
import { getAuthStore } from '../../stores/auth.store'
import { ProviderLoader } from '../../providers/loader'
import { validateBaseUrl } from '../../utils/validate-url'

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    const store = getProviderStore()

    // Validate both representations before merging so neither can mask invalid input.
    validateProviderApiType(body.api_type)
    validateProviderApiType(body.connection?.api_type)

    if (!body.name) {
      throw createError({ statusCode: 400, message: 'Provider name is required' })
    }

    const protocol = body.protocol || providerRegistry.defaultProviderId
    validateRegisteredProvider(protocol)
    const management = providerRegistry.get(protocol)?.management
    const pluginExtra = acceptsProviderExtra(protocol)
      ? validatePluginConnectionExtra(protocol, body.connection?.extra !== undefined ? body.connection.extra : body.extra)
      : undefined

    if (management?.creationError) {
      throw createError({ statusCode: 400, message: management.creationError })
    }

    const baseUrl = management?.flatCreateCredentials ? body.base_url : body.connection?.base_url ?? body.base_url
    if (baseUrl) {
      const ssrfConfig = await getAuthStore().getSSRFConfig()
      const result = validateBaseUrl(baseUrl, ssrfConfig)
      if (!result.valid) {
        throw createError({ statusCode: 400, message: `Invalid base URL: ${result.reason}` })
      }
    }

    const newProvider: ProviderConfig = {
      name: body.name,
      display_name: body.display_name || body.name,
      protocol: body.protocol || providerRegistry.defaultProviderId,
      enabled: body.enabled !== false,
      use_custom_models: body.use_custom_models || false,
      connection: {
        ...(body.connection?.api_type !== undefined || body.api_type !== undefined
          ? { api_type: body.connection?.api_type ?? body.api_type }
          : {}),
        ...(pluginExtra !== undefined ? { extra: pluginExtra } : {}),
        api_key: (management?.flatCreateCredentials ? body.api_key : body.connection?.api_key ?? body.api_key) || '',
        base_url: baseUrl || '',
        timeout: body.timeout || 30000,
        enable_timeout: body.enable_timeout ?? true,
        max_retries: body.max_retries || 3,
        version: body.version || ''
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
