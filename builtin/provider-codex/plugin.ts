import type { PluginAPI } from '../../server/plugins-runtime/manager'
import { CodexAdapter } from './codex'
import { fetchCodexModels } from './model-discovery'
import { management } from './management'
import { ensureCodexAccessToken } from './codex-token-manager'
import { fetchCodexUsage, consumeCodexResetCredit } from './subscription-usage'

export default {
  setup(api: PluginAPI) {
    api.registerProvider({
      id: 'codex-subscription',
      management,
      createAdapter: config => new CodexAdapter(config),
      fetchModels: fetchCodexModels,
      secretConnectionFields: [],
      requiresRefreshToken: true,
      refreshAccessToken: ensureCodexAccessToken,
      subscriptionUsage: fetchCodexUsage,
      login: { path: '/api/hub/providers/codex-login' },
      resetSubscriptionUsage: consumeCodexResetCredit
    })
  }
}
