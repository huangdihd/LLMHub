import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { incrementCalls } from './service'

export default {
  setup(api: PluginAPI) {
    api.registerHook({
      id: 'calls',
      onComplete() {
        return incrementCalls()
      }
    })
  }
}
