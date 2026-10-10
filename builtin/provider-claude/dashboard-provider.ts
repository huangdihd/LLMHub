import type { DashboardProviderExtension } from '~/shared/dashboard/providers'
import Form from './components/ProviderForm.vue'
import Advanced from './components/ProviderAdvanced.vue'

export default {
  id: "claude", order: 4, label: "Anthropic Claude",
  description: "Providers using the Anthropic Messages API.", icon: "i-heroicons-chat-bubble-left-right", form: Form,
  validate: ({ form, errors, editingProvider }) => {
    if (!form.base_url.trim()) errors.base_url = 'Enter the provider base URL'
    if (!editingProvider.value && !form.api_key.trim()) errors.api_key = 'Enter an API key'
    return !errors.base_url && !errors.api_key
  },
  advanced: Advanced,
  chooseDefaults: { base_url: "https://api.anthropic.com" },
  defaults: {"base_url": "", "api_key": "", "version": "2023-06-01"},
  edit: (form, provider) => { form.base_url = provider.connection.base_url || ''
    form.version = provider.connection.version || "2023-06-01" },
  sharedPayload: form => ({ version: form.version }),
  payload: form => ({ base_url: form.base_url, api_key: form.api_key })
} satisfies DashboardProviderExtension
