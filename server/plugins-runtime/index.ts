import { PluginManager } from './manager'
import { providerRegistry } from '../providers/builtins'
import { requestHooks } from '../core/hooks'
import { ProviderLoader } from '../providers/loader'

export { PluginManager } from './manager'
export { PluginError } from './manifest'
export type { PluginAPI, PluginModule, PluginStorage, PluginManagerOptions } from './manager'
export type { PluginField, PluginManifest, PluginRecord } from '../../shared/types/plugin'

let manager: PluginManager | undefined

export function getPluginManager(): PluginManager {
  if (!manager) manager = new PluginManager({
    storage: useStorage('data'), providerRegistry, hookRegistry: requestHooks,
    onRegistryChange: () => ProviderLoader.invalidateCache()
  })
  return manager
}
