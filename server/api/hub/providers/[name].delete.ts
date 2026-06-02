import { getProviderStore } from '../../../stores/provider.store'

export default defineEventHandler(async (event) => {
  try {
    const name = getRouterParam(event, 'name')
    const store = getProviderStore()
    const deleted = await store.delete(name!)

    if (!deleted) {
      throw createError({ statusCode: 404, message: 'Provider not found' })
    }

    return { success: true }
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
