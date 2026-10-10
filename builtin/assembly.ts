import { requestHooks } from '../server/core/hooks'
import { providerRegistry } from '../server/core/registry'
import { protocolRegistry } from '../server/core/protocol-registry'
import { ingressRegistry } from '../server/core/ingress-registry'
import { builtinCatalog, type BuiltinPlugin } from './catalog'
import { dependencyOrder } from '../server/plugins-runtime/dependencies'
import { PluginError } from '../server/plugins-runtime/manifest'
import { BuiltinPluginHost } from './host'
import { BUILTIN_PROVIDER_IDS } from './provider-ids'

// Persisted defaults and legacy API wording belong to the composition, not core dispatch.
providerRegistry.defaultProviderId = BUILTIN_PROVIDER_IDS.openai
providerRegistry.ignoredNestedConnectionUpdates = [
  'auto_reset_on_quota_exhausted', 'use_ai_credits_on_quota_exhausted'
]
providerRegistry.subscriptionResetErrors = {
  unsupportedProvider: 'Provider does not use a Codex subscription',
  unsupportedOperation: 'Usage limit resets are only available for Codex subscription providers'
}

/** Storage is resolved at operation time, so importing outside Nitro is safe. */
export const builtinHost = new BuiltinPluginHost({
  pluginOrder: builtinCatalog.map(plugin => plugin.manifest.id),
  hookRegistry: requestHooks,
  providerRegistry,
  protocolRegistry,
  ingressRegistry,
  storage: {
    getItem: <T>(key: string) => useStorage('data').getItem(key) as Promise<T | null>,
    setItem: (key, value) => useStorage('data').setItem(key, value as any),
    removeItem: key => useStorage('data').removeItem(key)
  }
})

/** Pull dependencies forward without moving unrelated parsers into earlier topology layers. */
export function orderBuiltinPlugins(plugins: readonly BuiltinPlugin[]): BuiltinPlugin[] {
  const { cycles } = dependencyOrder(plugins.map(plugin => plugin.manifest))
  if (cycles.size) throw new PluginError([...new Set(cycles.values())].join('; '))
  const byId = new Map(plugins.map(plugin => [plugin.manifest.id, plugin]))
  if (byId.size !== plugins.length) throw new PluginError('Duplicate builtin plugin identifier')
  const visited = new Set<string>()
  const ordered: BuiltinPlugin[] = []
  const visit = (plugin: BuiltinPlugin) => {
    if (visited.has(plugin.manifest.id)) return
    visited.add(plugin.manifest.id)
    const dependencies = { ...plugin.manifest.optionalDependencies, ...plugin.manifest.dependencies }
    for (const id of Object.keys(dependencies)) {
      const dependency = byId.get(id)
      if (dependency) visit(dependency)
    }
    ordered.push(plugin)
  }
  for (const plugin of plugins) visit(plugin)
  return ordered
}

let initialization: Promise<void> | undefined

/** Non-Nitro callers must await this before using the shared registries. */
export function initializeBuiltinPlugins(): Promise<void> {
  initialization ??= (async () => {
    try {
      for (const plugin of orderBuiltinPlugins(builtinCatalog)) await builtinHost.register(plugin)
    } catch (error) {
      try { await builtinHost.shutdown() }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Builtin initialization failed') }
      throw error
    }
  })()
  return initialization
}

export { requestHooks }
