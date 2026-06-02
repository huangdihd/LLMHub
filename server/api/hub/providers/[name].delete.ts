import { getProviderStore } from '../../../stores/provider.store'
import { ProviderLoader } from '../../../providers/loader'

export default defineEventHandler(async (event) => {
  try {
    const name = getRouterParam(event, 'name')
    const store = getProviderStore()
    const deleted = await store.delete(name!)

    if (!deleted) {
      throw createError({ statusCode: 404, message: 'Provider not found' })
    }

    ProviderLoader.invalidateCache()
    return { success: true }
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
