import { getProviderStore } from '../../stores/provider.store'

export default defineEventHandler(async () => {
  try {
    const store = getProviderStore()
    const providers = await store.getAll()
    return { providers: providers.map(p => store.sanitize(p)) }
  } catch (error: any) {
    throwFormattedError(error)
  }
})
