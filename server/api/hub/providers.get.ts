import { getProviderStore } from '../../stores/provider.store'
import { providerRegistry } from '../../core/registry'

export default defineEventHandler(async () => {
  try {
    const store = getProviderStore()
    const providers = await store.getAll()
    return {
      providers: providers.map(provider => ({
        ...store.sanitize(provider),
        ...(!providerRegistry.get(provider.protocol)
          ? { available: false, unavailableReason: 'Provider plugin is not loaded' }
          : {})
      }))
    }
  } catch (error: any) {
    throwFormattedError(error)
  }
})
