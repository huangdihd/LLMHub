import type { ProviderConfig } from '../../../core/types'
import { getProviderStore } from '../../../stores/provider.store'
import { getAuthStore } from '../../../stores/auth.store'
import { ProviderLoader } from '../../../providers/loader'
import { validateBaseUrl } from '../../../utils/validate-url'

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    const name = getRouterParam(event, 'name')
    const store = getProviderStore()

    if (!name) {
      throw createError({ statusCode: 400, message: 'Provider name is required' })
    }

    const existing = await store.get(name)
    if (!existing) {
      throw createError({ statusCode: 404, message: 'Provider not found' })
    }

    const nextProtocol = body.protocol ?? existing.protocol
    const nextDeviceId = body.device_id ?? body.connection?.device_id ?? existing.connection.device_id
    if (nextProtocol === 'codex-subscription' && !nextDeviceId?.trim()) {
      throw createError({ statusCode: 400, message: 'Device ID is required for Codex Subscription providers' })
    }

    // Validate base_url if it's being changed
    const newBaseUrl = body.base_url ?? body.connection?.base_url
    if (newBaseUrl) {
      const ssrfConfig = await getAuthStore().getSSRFConfig()
      const result = validateBaseUrl(newBaseUrl, ssrfConfig)
      if (!result.valid) {
        throw createError({ statusCode: 400, message: `Invalid base URL: ${result.reason}` })
      }
    }

    // Build the connection patch from flat or nested body fields
    const connectionPatch: any = {}
    if (body.base_url !== undefined) connectionPatch.base_url = body.base_url
    // Sanitized provider responses intentionally omit the current secret, so
    // an empty password field in the edit form means "keep the existing key".
    if (body.api_key !== undefined && body.api_key !== '') connectionPatch.api_key = body.api_key
    if (body.timeout !== undefined) connectionPatch.timeout = body.timeout
    if (body.enable_timeout !== undefined) connectionPatch.enable_timeout = body.enable_timeout
    if (body.max_retries !== undefined) connectionPatch.max_retries = body.max_retries
    if (body.version !== undefined) connectionPatch.version = body.version
    if (body.device_id !== undefined) connectionPatch.device_id = body.device_id?.trim()
    if (body.account_id !== undefined) connectionPatch.account_id = body.account_id?.trim()
    // Also merge any nested connection object
    if (body.connection && typeof body.connection === 'object') {
      Object.assign(connectionPatch, body.connection)
    }

    const patch: Partial<ProviderConfig> = {
      ...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
      ...(body.protocol !== undefined ? { protocol: body.protocol } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.use_custom_models !== undefined ? { use_custom_models: body.use_custom_models } : {}),
      ...(body.normalize_cch !== undefined ? { normalize_cch: body.normalize_cch } : {}),
      ...(body.models !== undefined ? { models: body.models } : {}),
      ...(body.defaults !== undefined ? { defaults: body.defaults } : {}),
      ...(Object.keys(connectionPatch).length > 0 ? { connection: connectionPatch } : {})
    }

    const updated = await store.update(name, patch)

    if (!updated) {
      throw createError({ statusCode: 404, message: 'Provider not found' })
    }

    ProviderLoader.invalidateCache()
    return { success: true, provider: store.sanitize(updated) }
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
