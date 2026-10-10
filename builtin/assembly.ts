import { requestHooks } from '../server/core/hooks'
import { providerRegistry } from '../server/providers/builtins'
import { builtinCatalog } from './catalog'
import { BuiltinPluginHost } from './host'

/** Storage is resolved at operation time, so importing outside Nitro is safe. */
export const builtinHost = new BuiltinPluginHost({
  hookRegistry: requestHooks,
  providerRegistry,
  storage: {
    getItem: <T>(key: string) => useStorage('data').getItem(key) as Promise<T | null>,
    setItem: (key, value) => useStorage('data').setItem(key, value as any),
    removeItem: key => useStorage('data').removeItem(key)
  }
})

let initialization: Promise<void> | undefined

/** Non-Nitro callers must await this before using the shared registries. */
export function initializeBuiltinPlugins(): Promise<void> {
  initialization ??= (async () => {
    try {
      for (const plugin of builtinCatalog) await builtinHost.register(plugin)
    } catch (error) {
      try { await builtinHost.shutdown() }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Builtin initialization failed') }
      throw error
    }
  })()
  return initialization
}

export { requestHooks }
