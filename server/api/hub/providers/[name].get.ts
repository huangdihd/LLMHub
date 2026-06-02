import { getProviderStore } from '../../../stores/provider.store'

export default defineEventHandler(async (event) => {
  try {
    const name = getRouterParam(event, 'name')
    const store = getProviderStore()
    const provider = await store.get(name!)

    if (!provider) {
      throw createError({ statusCode: 404, message: 'Provider not found' })
    }

    return { provider }
  } catch (error: any) {
    if (error.statusCode) throw error
    throwFormattedError(error)
  }
})
