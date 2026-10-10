import type { DashboardProviderExtension } from '~/shared/dashboard/providers'
import Form from './components/ProviderForm.vue'

export default {
  id: "openai", order: 0, label: "OpenAI compatible",
  description: "OpenAI, DeepSeek, OpenRouter, Ollama, and compatible APIs.", icon: "i-heroicons-command-line", form: Form,
  emptyDescription: "Add an API provider or connect a ChatGPT subscription.",
  validate: ({ form, errors, editingProvider }) => {
    if (!form.base_url.trim()) errors.base_url = 'Enter the provider base URL'
    if (!editingProvider.value && !form.api_key.trim()) errors.api_key = 'Enter an API key'
    return !errors.base_url && !errors.api_key
  },
  chooseDefaults: { base_url: "https://api.openai.com/v1" },
  defaults: {"base_url": "", "api_key": "", "api_type": "responses"},
  edit: (form, provider) => { form.base_url = provider.connection.base_url || ''
    form.api_type = provider.connection.api_type ?? 'chat_completions' },
  payload: form => ({ base_url: form.base_url, api_key: form.api_key, api_type: form.api_type })
} satisfies DashboardProviderExtension
