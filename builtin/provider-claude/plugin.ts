import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { ClaudeAdapter } from './claude'
import { fetchClaudeModels } from './model-discovery'
import { management } from './management'

export default {
  setup(api: PluginAPI) {
    api.registerProvider({
      id: 'claude',
      management,
      createAdapter: config => new ClaudeAdapter(config),
      fetchModels: fetchClaudeModels,
      secretConnectionFields: []
    })
  }
}
