import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { GeminiAdapter } from './gemini'
import { fetchGeminiModels } from './model-discovery'
import { management } from './management'

export default {
  setup(api: PluginAPI) {
    api.registerProvider({
      id: 'gemini',
      management,
      createAdapter: config => new GeminiAdapter(config),
      fetchModels: fetchGeminiModels,
      secretConnectionFields: []
    })
  }
}
