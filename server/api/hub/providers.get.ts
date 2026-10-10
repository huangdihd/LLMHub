import { getProviderStore, isBuiltinProvider } from '../../stores/provider.store'
import { providerRegistry } from '../../providers/builtins'

export default defineEventHandler(async () => {
  try {
    const store = getProviderStore()
    const providers = await store.getAll()
    return {
      providers: providers.map(provider => ({
        ...store.sanitize(provider),
        ...(!isBuiltinProvider(provider.protocol) && !providerRegistry.get(provider.protocol)
          ? { available: false, unavailableReason: 'Provider plugin is not loaded' }
          : {})
      }))
    }
  } catch (error: any) {
    throwFormattedError(error)
  }
})
