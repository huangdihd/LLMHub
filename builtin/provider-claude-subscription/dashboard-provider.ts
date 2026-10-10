import type { DashboardProviderExtension } from '~/shared/dashboard/providers'
import Form from './components/ProviderForm.vue'
import { createDashboard } from './dashboard-state'
import Badge from './components/ProviderBadge.vue'
import Actions from './components/ProviderActions.vue'
import Details from './components/ProviderDetails.vue'

export default {
  id: "claude-subscription", order: 2, label: "Claude Code subscription",
  description: "Use Claude models included with a Claude plan. Sign in with Anthropic.", icon: "i-heroicons-user-circle", form: Form,
  initial: { display_name: "Claude Subscription", name: "claude-sub", timeout: 30000 },
  connectedLabel: "Claude connected", create: createDashboard, badge: Badge, actions: Actions, details: Details,
  defaults: {},
  edit: (form, provider) => {  },
  payload: form => ({})
} satisfies DashboardProviderExtension
