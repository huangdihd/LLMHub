import { PluginManager } from './manager'
import { providerRegistry } from '../providers/builtins'
import { requestHooks } from '../core/hooks'
import type { PluginManagerOptions } from './manager'
import { ProviderLoader } from '../providers/loader'

export { PluginManager } from './manager'
export { PluginError } from './manifest'
export type { PluginAPI, PluginModule, PluginStorage, PluginManagerOptions } from './manager'
export type { PluginField, PluginManifest, PluginRecord } from '../../shared/types/plugin'

let manager: PluginManager | undefined
let builtinOptions: Pick<PluginManagerOptions, 'builtinPlugins' | 'dispatchBuiltinRoute'> = {}

export function configureBuiltinHost(options: typeof builtinOptions): void {
  if (manager) throw new Error('Builtin host must be configured before plugin manager creation')
  builtinOptions = options
}

export function getPluginManager(): PluginManager {
  if (!manager) manager = new PluginManager({
    ...builtinOptions,
    storage: useStorage('data'), providerRegistry, hookRegistry: requestHooks,
    onRegistryChange: () => ProviderLoader.invalidateCache()
  })
  return manager
}
