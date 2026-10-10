import type { DashboardProviderExtension } from '~/shared/dashboard/providers'
import Form from './components/ProviderForm.vue'
import { createDashboard } from './dashboard-state'
import Badge from './components/ProviderBadge.vue'
import Actions from './components/ProviderActions.vue'
import Details from './components/ProviderDetails.vue'
import Advanced from './components/ProviderAdvanced.vue'

export default {
  id: "codex-subscription", order: 1, label: "ChatGPT subscription",
  description: "Use Codex models included with a ChatGPT plan. Sign in with OpenAI.", icon: "i-heroicons-user-circle", form: Form,
  initial: { display_name: "Codex Subscription", name: "codex", timeout: 30000 },
  connectedLabel: "ChatGPT connected", create: createDashboard, badge: Badge, actions: Actions, details: Details,
  advanced: Advanced,
  defaults: {"client_version": "0.149.0"},
  edit: (form, provider) => { 
    form.client_version = provider.connection.client_version || "0.149.0" },
  sharedPayload: form => ({ client_version: form.client_version }),
  payload: () => ({})
} satisfies DashboardProviderExtension
