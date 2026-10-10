import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { getBillableTokens } from './service'

export default {
  setup(api: PluginAPI) {
    api.provide({ getBillableTokens })
  }
}
