import { getPluginManager } from '../plugins-runtime'

export default defineNitroPlugin(async application => {
  const manager = getPluginManager()
  try { await manager.scan() }
  catch { console.error('[LLMHub] Runtime plugin discovery failed; built-in providers remain available') }
  application.hooks.hook('close', () => manager.shutdown())
})
