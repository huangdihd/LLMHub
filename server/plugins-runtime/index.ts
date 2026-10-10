import { PluginManager } from './manager'
import { providerRegistry } from '../core/registry'
import { protocolRegistry } from '../core/protocol-registry'
import { ingressRegistry } from '../core/ingress-registry'
import { requestHooks } from '../core/hooks'
import type { PluginManagerOptions } from './manager'
import { readApiKeys } from '../stores/api-key-storage'
import { getProviderStore } from '../stores/provider.store'
import { ProviderManager } from '../providers/manager'
import { ProviderLoader } from '../providers/loader'

export { PluginManager } from './manager'
export { PluginError } from './manifest'
export type { PluginAPI, PluginModule, PluginStorage, PluginManagerOptions } from './manager'
export type { PluginField, PluginManifest, PluginRecord } from '../../shared/types/plugin'

let manager: PluginManager | undefined
let builtinOptions: Pick<PluginManagerOptions, 'builtinPlugins' | 'dispatchBuiltinRoute' | 'requireBuiltin'> = {}

export function configureBuiltinHost(options: typeof builtinOptions): void {
  if (manager) throw new Error('Builtin host must be configured before plugin manager creation')
  builtinOptions = options
}

export function getPluginManager(): PluginManager {
  if (!manager) manager = new PluginManager({
    ...builtinOptions,
    listRecordIds: async location => {
      if (location === 'apiKeys') return (await readApiKeys()).map(record => record.id)
      if (location === 'providers') return getProviderStore().list()
      const providers = new ProviderManager()
      await providers.loadProviders()
      return (await providers.getModels()).map(model => model.id)
    },
    storage: useStorage('data'), providerRegistry, hookRegistry: requestHooks, protocolRegistry, ingressRegistry,
    onRegistryChange: () => ProviderLoader.invalidateCache()
  })
  return manager
}
