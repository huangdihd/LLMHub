import type { ProviderConfig } from '../../../core/types'
import { getProviderStore } from '../../../stores/provider.store'
import { ProviderLoader } from '../../../providers/loader'

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    const name = getRouterParam(event, 'name')
    const store = getProviderStore()

    if (!name) {
      throw createError({ statusCode: 400, message: 'Provider name is required' })
    }

    // Build the connection patch from flat or nested body fields
    const connectionPatch: any = {}
    if (body.base_url !== undefined) connectionPatch.base_url = body.base_url
    if (body.api_key !== undefined) connectionPatch.api_key = body.api_key
    if (body.timeout !== undefined) connectionPatch.timeout = body.timeout
    if (body.max_retries !== undefined) connectionPatch.max_retries = body.max_retries
    if (body.version !== undefined) connectionPatch.version = body.version
    // Also merge any nested connection object
    if (body.connection && typeof body.connection === 'object') {
      Object.assign(connectionPatch, body.connection)
    }

    const patch: Partial<ProviderConfig> = {
      ...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
      ...(body.protocol !== undefined ? { protocol: body.protocol } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.use_custom_models !== undefined ? { use_custom_models: body.use_custom_models } : {}),
      ...(body.models !== undefined ? { models: body.models } : {}),
      ...(body.defaults !== undefined ? { defaults: body.defaults } : {}),
      ...(Object.keys(connectionPatch).length > 0 ? { connection: connectionPatch } : {})
    }

    const updated = await store.update(name, patch)

    if (!updated) {
      throw createError({ statusCode: 404, message: 'Provider not found' })
    }

    ProviderLoader.invalidateCache()
    return { success: true, provider: updated }
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
