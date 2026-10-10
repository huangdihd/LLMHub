import { providerRegistry } from '../../../core/registry'
import type { ProviderConfig } from '../../../core/types'
import { getProviderStore, acceptsProviderExtra, validatePluginConnectionExtra, validateProviderApiType, validateRegisteredProvider } from '../../../stores/provider.store'
import { getAuthStore } from '../../../stores/auth.store'
import { ProviderLoader } from '../../../providers/loader'
import { validateBaseUrl } from '../../../utils/validate-url'

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    const name = getRouterParam(event, 'name')
    const store = getProviderStore()

    // Validate both representations before merging so neither can mask invalid input.
    validateProviderApiType(body.api_type)
    validateProviderApiType(body.connection?.api_type)

    if (!name) {
      throw createError({ statusCode: 400, message: 'Provider name is required' })
    }

    const existing = await store.get(name)
    if (!existing) {
      throw createError({ statusCode: 404, message: 'Provider not found' })
    }

    const nextProtocol = body.protocol ?? existing.protocol
    validateRegisteredProvider(nextProtocol)
    const management = providerRegistry.get(nextProtocol)?.management
    const pluginExtra = acceptsProviderExtra(nextProtocol)
      ? validatePluginConnectionExtra(
        nextProtocol,
        body.connection?.extra !== undefined ? body.connection.extra : body.extra,
        nextProtocol === existing.protocol ? existing.connection.extra : undefined
      )
      : undefined
    if (management?.creationError && nextProtocol !== existing.protocol) {
      throw createError({ statusCode: 400, message: management.creationError })
    }
    const protectedFields = management?.protectedConnectionFields ?? []

    // Nested connection fields win during merging; validate that same effective URL.
    const newBaseUrl = body.connection?.base_url ?? body.base_url
    if (newBaseUrl) {
      const ssrfConfig = await getAuthStore().getSSRFConfig()
      const result = validateBaseUrl(newBaseUrl, ssrfConfig)
      if (!result.valid) {
        throw createError({ statusCode: 400, message: `Invalid base URL: ${result.reason}` })
      }
    }

    // Build the connection patch from flat or nested body fields
    const connectionPatch: any = {}
    if (body.api_type !== undefined) connectionPatch.api_type = body.api_type
    if (body.base_url !== undefined && !protectedFields.includes('base_url')) connectionPatch.base_url = body.base_url
    // Sanitized provider responses intentionally omit the current secret, so
    // an empty password field in the edit form means "keep the existing key".
    if (body.api_key !== undefined && body.api_key !== '' && !protectedFields.includes('api_key')) connectionPatch.api_key = body.api_key
    if (body.timeout !== undefined) connectionPatch.timeout = body.timeout
    if (body.enable_timeout !== undefined) connectionPatch.enable_timeout = body.enable_timeout
    if (body.max_retries !== undefined) connectionPatch.max_retries = body.max_retries
    if (body.version !== undefined) connectionPatch.version = body.version
    for (const [field, normalize] of Object.entries(management?.flatConnectionFields ?? {})) {
      if (body[field] !== undefined) connectionPatch[field] = normalize(body[field])
    }
    // Also merge any nested connection object
    if (body.connection && typeof body.connection === 'object') {
      const nested = { ...body.connection }
      for (const field of providerRegistry.ignoredNestedConnectionUpdates) delete nested[field]
      for (const field of protectedFields) delete nested[field]
      Object.assign(connectionPatch, nested)
    }

    if (pluginExtra !== undefined) {
      connectionPatch.extra = pluginExtra
      if (connectionPatch.api_key === '') delete connectionPatch.api_key
    }

    // Apply provider protection to both flat and nested representations.
    for (const field of protectedFields) delete connectionPatch[field]

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
