import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { ClaudeSubscriptionAdapter } from './claude-subscription'
import { fetchClaudeSubscriptionModels } from './model-discovery'
import { management } from './management'
import { ensureClaudeAccessToken } from './claude-token-manager'
import { fetchClaudeUsage } from './subscription-usage'

export default {
  setup(api: PluginAPI) {
    api.registerProvider({
      id: 'claude-subscription',
      management,
      createAdapter: config => new ClaudeSubscriptionAdapter(config),
      fetchModels: fetchClaudeSubscriptionModels,
      secretConnectionFields: [],
      requiresRefreshToken: true,
      refreshAccessToken: ensureClaudeAccessToken,
      subscriptionUsage: fetchClaudeUsage,
      login: { path: '/api/hub/providers/claude-login' }
    })
  }
}
