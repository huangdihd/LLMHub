import { configureBuiltinHost, getPluginManager } from '../plugins-runtime'
import { builtinHost, initializeBuiltinPlugins } from '../../builtin/assembly'

export default defineNitroPlugin(async application => {
  await initializeBuiltinPlugins()
  configureBuiltinHost({
    builtinPlugins: () => builtinHost.list(),
    dispatchBuiltinRoute: (id, method, path, event) => builtinHost.dispatchRoute(id, method, path, event)
  })
  const manager = getPluginManager()
  try { await manager.scan() }
  catch { console.error('[LLMHub] Runtime plugin discovery failed; built-in providers remain available') }
  application.hooks.hook('close', async () => {
    try { await manager.shutdown() }
    finally { await builtinHost.shutdown() }
  })
})
