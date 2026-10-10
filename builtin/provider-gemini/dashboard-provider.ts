import type { DashboardProviderExtension } from '~/shared/dashboard/providers'
import Form from './components/ProviderForm.vue'

export default {
  id: "gemini", order: 5, label: "Google Gemini",
  description: "Providers using the Gemini generateContent API.", icon: "i-heroicons-sparkles", form: Form,
  validate: ({ form, errors, editingProvider }) => {
    if (!form.base_url.trim()) errors.base_url = 'Enter the provider base URL'
    if (!editingProvider.value && !form.api_key.trim()) errors.api_key = 'Enter an API key'
    return !errors.base_url && !errors.api_key
  },
  chooseDefaults: { base_url: "https://generativelanguage.googleapis.com" },
  defaults: {"base_url": "", "api_key": ""},
  edit: (form, provider) => { form.base_url = provider.connection.base_url || '' },
  payload: form => ({ base_url: form.base_url, api_key: form.api_key })
} satisfies DashboardProviderExtension
