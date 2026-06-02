import { getProviderStore } from '../../stores/provider.store'

export default defineEventHandler(async () => {
  try {
    const store = getProviderStore()
    const providers = await store.getAll()
    return { providers }
  } catch (error: any) {
    throwFormattedError(error)
  }
})
