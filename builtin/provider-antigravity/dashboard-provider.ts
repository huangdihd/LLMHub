import type { DashboardProviderExtension } from '~/shared/dashboard/providers'
import Form from './components/ProviderForm.vue'
import { createDashboard } from './dashboard-state'
import Badge from './components/ProviderBadge.vue'
import Actions from './components/ProviderActions.vue'
import Details from './components/ProviderDetails.vue'

export default {
  id: "antigravity-subscription", order: 3, label: "Google Antigravity subscription",
  description: "Use Gemini and Claude models included with Google Antigravity.", icon: "i-heroicons-sparkles", form: Form,
  initial: { display_name: "Antigravity Subscription", name: "antigravity", timeout: 120000 },
  connectedLabel: "Google connected", create: createDashboard, badge: Badge, actions: Actions, details: Details,
  defaults: {},
  edit: (form, provider) => {  },
  payload: form => ({})
} satisfies DashboardProviderExtension
