import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { AntigravityAdapter } from './antigravity'
import { discoverAntigravityModels } from './model-discovery'
import { management } from './management'
import { ensureAntigravityAccessToken } from './antigravity-token-manager'
import { fetchAntigravityUsage } from './subscription-usage'

export default {
  setup(api: PluginAPI) {
    api.registerProvider({
      id: 'antigravity-subscription',
      management,
      createAdapter: config => new AntigravityAdapter(config),
      fetchModels: discoverAntigravityModels,
      secretConnectionFields: [],
      requiresRefreshToken: true,
      refreshAccessToken: ensureAntigravityAccessToken,
      subscriptionUsage: fetchAntigravityUsage,
      login: { path: '/api/hub/providers/antigravity-login' }
    })
  }
}
