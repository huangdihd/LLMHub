<template>
  <UContainer class="py-8 max-w-5xl">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
      <div>
        <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Providers</h2>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Connect the accounts LLMHub uses to run model requests.</p>
      </div>
      <UButton icon="i-heroicons-plus" class="self-start sm:self-auto" @click="openAddModal">Add provider</UButton>
    </div>

    <div v-if="loading" class="flex justify-center py-16">
      <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 animate-spin text-gray-400" />
    </div>

    <UCard v-else-if="providers.length === 0" class="text-center">
      <div class="py-10">
        <UIcon name="i-heroicons-link" class="w-10 h-10 mx-auto text-gray-300 dark:text-gray-600" />
        <h3 class="mt-4 font-medium text-gray-900 dark:text-white">No providers connected</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Add an API provider or connect a ChatGPT subscription.</p>
        <UButton class="mt-5" @click="openAddModal">Add your first provider</UButton>
      </div>
    </UCard>

    <div v-else class="space-y-4">
      <UCard v-for="provider in providers" :key="provider.name">
        <div class="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="text-lg font-medium text-gray-900 dark:text-white">{{ provider.display_name }}</h3>
              <UBadge :color="provider.enabled ? 'green' : 'gray'" variant="subtle" size="sm">
                {{ provider.enabled ? 'Enabled' : 'Disabled' }}
              </UBadge>
              <UBadge
                v-if="provider.protocol === 'codex-subscription'"
                :color="provider.connection.authenticated ? 'green' : 'red'"
                variant="subtle"
                size="sm"
              >
                {{ provider.connection.authenticated ? 'ChatGPT connected' : 'Reconnect required' }}
              </UBadge>
            </div>
            <div class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
              <span>{{ protocolLabel(provider.protocol) }}</span>
              <span class="font-mono text-xs">{{ provider.name }}</span>
              <span v-if="provider.protocol !== 'codex-subscription'" class="break-all">{{ provider.connection.base_url }}</span>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <UButton
              color="gray"
              variant="soft"
              class="dark:!bg-gray-800 dark:!text-gray-100 dark:hover:!bg-gray-700"
              icon="i-heroicons-pencil-square"
              @click="editProvider(provider)"
            >Edit</UButton>
            <UButton color="red" variant="ghost" icon="i-heroicons-trash" @click="deleteProvider(provider.name)">Delete</UButton>
          </div>
        </div>
      </UCard>
    </div>

    <UModal v-model="isModalOpen" :ui="{ width: 'sm:max-w-2xl' }" prevent-close>
      <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
        <template #header>
          <div class="flex items-center justify-between gap-4">
            <div>
              <h3 class="font-semibold text-gray-900 dark:text-white">{{ modalTitle }}</h3>
              <p v-if="protocolChosen" class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{{ protocolLabel(form.protocol) }}</p>
            </div>
            <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark-20-solid" :disabled="saving" @click="closeModal" />
          </div>
        </template>

        <div v-if="!protocolChosen" class="space-y-4">
          <div>
            <h4 class="font-medium text-gray-900 dark:text-white">What do you want to connect?</h4>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Choose the API format your upstream provider uses.</p>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              v-for="option in protocolOptions"
              :key="option.value"
              type="button"
              class="text-left rounded-lg border border-gray-200 dark:border-gray-700 p-4 transition hover:border-primary-500 hover:bg-gray-50 dark:hover:bg-gray-800/60 focus:outline-none focus:ring-2 focus:ring-primary-500"
              @click="chooseProtocol(option.value)"
            >
              <div class="flex items-center gap-3">
                <UIcon :name="option.icon" class="w-5 h-5 text-gray-500" />
                <span class="font-medium text-gray-900 dark:text-white">{{ option.label }}</span>
              </div>
              <p class="mt-2 text-sm leading-5 text-gray-500 dark:text-gray-400">{{ option.description }}</p>
            </button>
          </div>
        </div>

        <form v-else class="space-y-5" @submit.prevent="saveProvider">
          <div v-if="!editingProvider" class="flex justify-between items-center rounded-md bg-gray-50 dark:bg-gray-800/60 px-3 py-2">
            <span class="text-sm text-gray-600 dark:text-gray-300">Connecting {{ protocolLabel(form.protocol) }}</span>
            <UButton color="gray" variant="link" size="xs" type="button" @click="backToProtocolChoice">Change type</UButton>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <UFormGroup label="Display name" required :error="errors.display_name">
              <UInput v-model="form.display_name" placeholder="My provider" autofocus />
            </UFormGroup>
            <UFormGroup label="Provider ID" required :error="errors.name" help="Used in model names, for example provider-id/model-id.">
              <UInput v-model="form.name" :disabled="!!editingProvider" placeholder="my-provider" @input="nameTouched = true" />
            </UFormGroup>
          </div>

          <section v-if="form.protocol === 'codex-subscription'" class="rounded-lg border border-gray-200 dark:border-gray-700 p-4 sm:p-5">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div class="flex items-center gap-2">
                  <h4 class="font-medium text-gray-900 dark:text-white">ChatGPT subscription</h4>
                  <UBadge
                    v-if="editingProvider && !activeLogin"
                    :color="editingProvider.connection.authenticated ? 'green' : 'red'"
                    variant="subtle"
                    size="sm"
                  >
                    {{ editingProvider.connection.authenticated ? 'Connected' : 'Not connected' }}
                  </UBadge>
                </div>
                <p class="mt-1 text-sm leading-5 text-gray-500 dark:text-gray-400">
                  Sign in on OpenAI. LLMHub stores the session server-side and refreshes it automatically.
                </p>
              </div>
              <UButton
                v-if="activeLogin?.status !== 'pending'"
                type="button"
                icon="i-heroicons-arrow-top-right-on-square"
                :loading="startingLogin"
                @click="startCodexLogin"
              >
                {{ codexConnectLabel }}
              </UButton>
            </div>

            <div v-if="activeLogin?.status === 'pending'" class="mt-5 border-t border-gray-200 dark:border-gray-700 pt-5">
              <ol class="space-y-4">
                <li class="flex gap-3">
                  <span class="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-xs font-medium">1</span>
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-medium text-gray-900 dark:text-white">Open the secure OpenAI sign-in page</p>
                    <UButton class="mt-2" type="button" variant="soft" icon="i-heroicons-arrow-top-right-on-square" @click="openVerificationPage">Open ChatGPT</UButton>
                  </div>
                </li>
                <li class="flex gap-3">
                  <span class="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-xs font-medium">2</span>
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-medium text-gray-900 dark:text-white">Enter this one-time code</p>
                    <div class="mt-2 flex items-center gap-2">
                      <code class="rounded-md bg-gray-100 dark:bg-gray-800 px-3 py-2 font-mono text-lg tracking-wider text-gray-900 dark:text-white">{{ activeLogin.user_code }}</code>
                      <UButton type="button" color="gray" variant="ghost" icon="i-heroicons-clipboard-document" aria-label="Copy code" @click="copyLoginCode" />
                    </div>
                  </div>
                </li>
              </ol>
              <div class="mt-5 flex items-center justify-between gap-3 text-sm text-gray-500 dark:text-gray-400">
                <span class="flex items-center gap-2"><UIcon name="i-heroicons-arrow-path" class="w-4 h-4 animate-spin" /> Waiting for confirmation</span>
                <span>Expires in {{ loginMinutesRemaining }} min</span>
              </div>
            </div>

            <UAlert
              v-else-if="activeLogin?.status === 'failed'"
              class="mt-4"
              color="red"
              variant="subtle"
              title="Could not connect ChatGPT"
              :description="activeLogin.error"
            />
          </section>

          <section v-else class="space-y-4">
            <UFormGroup label="Base URL" required :error="errors.base_url" help="The root URL for this provider's API.">
              <UInput v-model="form.base_url" :placeholder="protocolDefaults[form.protocol].baseUrl" />
            </UFormGroup>
            <UFormGroup label="API key" :required="!editingProvider" :error="errors.api_key" :help="editingProvider ? 'Leave empty to keep the current key.' : 'Stored on the LLMHub server and never returned to the browser.'">
              <UInput v-model="form.api_key" type="password" autocomplete="new-password" :placeholder="editingProvider ? 'Keep current key' : protocolDefaults[form.protocol].keyPlaceholder" />
            </UFormGroup>
          </section>

          <details class="rounded-lg border border-gray-200 dark:border-gray-700">
            <summary class="cursor-pointer select-none px-4 py-3 text-sm font-medium text-gray-700 dark:text-gray-200">Advanced settings</summary>
            <div class="space-y-4 border-t border-gray-200 dark:border-gray-700 p-4">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Enabled</p>
                  <p class="text-xs text-gray-500 dark:text-gray-400">Allow this provider to receive requests.</p>
                </div>
                <UToggle v-model="form.enabled" />
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <UFormGroup label="Timeout">
                  <div class="flex items-center gap-2">
                    <UInput v-model.number="form.timeout" type="number" class="flex-1" :disabled="!form.enable_timeout" />
                    <span class="text-xs text-gray-500">ms</span>
                  </div>
                </UFormGroup>
                <UFormGroup label="Max retries">
                  <UInput v-model.number="form.max_retries" type="number" min="0" max="10" />
                </UFormGroup>
              </div>
              <UCheckbox v-model="form.enable_timeout" label="Enable request timeout" />

              <UFormGroup v-if="form.protocol === 'claude'" label="Anthropic API version">
                <UInput v-model="form.version" placeholder="2023-06-01" />
              </UFormGroup>

              <UFormGroup v-if="form.protocol === 'codex-subscription'" label="Codex client version" help="Sent to OpenAI when fetching the subscription model catalog.">
                <UInput v-model="form.client_version" placeholder="0.149.0" />
              </UFormGroup>

              <UCheckbox v-model="form.use_custom_models" label="Use a custom model list instead of fetching models" />
              <div v-if="form.use_custom_models" class="space-y-2 rounded-md bg-gray-50 dark:bg-gray-800/50 p-3">
                <div v-for="(model, index) in form.custom_models" :key="index" class="flex items-center gap-2">
                  <UInput v-model="model.id" placeholder="Model ID" class="flex-1" />
                  <UInput v-model="model.display_name" placeholder="Display name" class="flex-1" />
                  <UButton type="button" color="red" variant="ghost" icon="i-heroicons-trash" @click="form.custom_models.splice(index, 1)" />
                </div>
                <UButton type="button" color="gray" variant="soft" size="sm" @click="form.custom_models.push({ id: '', display_name: '' })">Add model</UButton>
              </div>

              <UCheckbox v-model="form.normalize_cch" label="Normalize cch in the system prompt for upstream cache reuse" />
            </div>
          </details>
        </form>

        <template #footer>
          <div class="flex justify-between gap-3">
            <UButton v-if="activeLogin?.status === 'pending'" color="red" variant="ghost" @click="cancelActiveLogin">Cancel login</UButton>
            <span v-else />
            <div class="flex gap-2">
              <UButton color="gray" variant="ghost" :disabled="saving" @click="closeModal">Cancel</UButton>
              <UButton
                v-if="protocolChosen && (form.protocol !== 'codex-subscription' || !!editingProvider)"
                :loading="saving"
                :disabled="activeLogin?.status === 'pending'"
                @click="saveProvider"
              >Save changes</UButton>
            </div>
          </div>
        </template>
      </UCard>
    </UModal>
  </UContainer>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

type Protocol = 'openai' | 'claude' | 'gemini' | 'codex-subscription'
type LoginState = {
  login_id: string
  status: 'pending' | 'completed' | 'failed' | 'cancelled'
  verification_url: string
  user_code: string
  expires_at: number
  error?: string
}

const toast = useToast()
const providers = ref<any[]>([])
const loading = ref(true)
const saving = ref(false)
const startingLogin = ref(false)
const isModalOpen = ref(false)
const protocolChosen = ref(false)
const editingProvider = ref<any>(null)
const activeLogin = ref<LoginState | null>(null)
const loginNow = ref(Date.now())
const nameTouched = ref(false)
let pollTimer: ReturnType<typeof setTimeout> | null = null

const protocolOptions: { value: Protocol; label: string; description: string; icon: string }[] = [
  { value: 'openai', label: 'OpenAI compatible', description: 'OpenAI, DeepSeek, OpenRouter, Ollama, and compatible APIs.', icon: 'i-heroicons-command-line' },
  { value: 'codex-subscription', label: 'ChatGPT subscription', description: 'Use Codex models included with a ChatGPT plan. Sign in with OpenAI.', icon: 'i-heroicons-user-circle' },
  { value: 'claude', label: 'Anthropic Claude', description: 'Providers using the Anthropic Messages API.', icon: 'i-heroicons-chat-bubble-left-right' },
  { value: 'gemini', label: 'Google Gemini', description: 'Providers using the Gemini generateContent API.', icon: 'i-heroicons-sparkles' }
]

const protocolDefaults: Record<Protocol, { baseUrl: string; keyPlaceholder: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', keyPlaceholder: 'sk-…' },
  claude: { baseUrl: 'https://api.anthropic.com', keyPlaceholder: 'sk-ant-…' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com', keyPlaceholder: 'Google API key' },
  'codex-subscription': { baseUrl: '', keyPlaceholder: '' }
}

const form = reactive({
  name: '', display_name: '', protocol: 'openai' as Protocol, enabled: true,
  use_custom_models: false, custom_models: [] as { id: string; display_name: string }[],
  base_url: '', api_key: '', timeout: 30000, enable_timeout: true,
  max_retries: 3, version: '2023-06-01', normalize_cch: false,
  client_version: '0.149.0'
})

const errors = reactive({ name: '', display_name: '', base_url: '', api_key: '' })
const modalTitle = computed(() => editingProvider.value ? `Edit ${editingProvider.value.display_name}` : 'Add provider')
const codexConnectLabel = computed(() => {
  if (activeLogin.value?.status === 'failed') return 'Try again'
  if (editingProvider.value) return 'Reconnect'
  return 'Connect ChatGPT'
})
const loginMinutesRemaining = computed(() => activeLogin.value
  ? Math.max(0, Math.ceil((activeLogin.value.expires_at - loginNow.value) / 60000))
  : 0)

watch(() => form.display_name, value => {
  if (!editingProvider.value && !nameTouched.value) form.name = slugify(value)
})

onMounted(loadProviders)
onBeforeUnmount(stopPolling)

async function loadProviders() {
  loading.value = true
  try {
    const data: any = await $fetch('/api/hub/providers')
    providers.value = data.providers || []
  } catch (error: any) {
    if (error?.statusCode === 401) return navigateTo('/login')
    showError(error, 'Unable to load providers')
  } finally {
    loading.value = false
  }
}

function openAddModal() {
  editingProvider.value = null
  resetForm()
  protocolChosen.value = false
  isModalOpen.value = true
}

function chooseProtocol(protocol: Protocol) {
  form.protocol = protocol
  const option = protocolOptions.find(item => item.value === protocol)!
  form.display_name = protocol === 'codex-subscription' ? 'Codex Subscription' : option.label
  form.base_url = protocolDefaults[protocol].baseUrl
  form.name = protocol === 'codex-subscription' ? 'codex' : slugify(form.display_name)
  nameTouched.value = false
  protocolChosen.value = true
}

function backToProtocolChoice() {
  if (activeLogin.value?.status === 'pending') return
  resetForm()
  protocolChosen.value = false
}

function editProvider(provider: any) {
  resetForm()
  editingProvider.value = provider
  protocolChosen.value = true
  form.name = provider.name
  form.display_name = provider.display_name
  form.protocol = provider.protocol
  form.enabled = provider.enabled
  form.use_custom_models = provider.use_custom_models || false
  form.custom_models = (provider.models || []).map((model: any) => ({ id: model.id, display_name: model.display_name }))
  form.base_url = provider.connection.base_url || ''
  form.timeout = provider.connection.timeout || 30000
  form.enable_timeout = provider.connection.enable_timeout ?? true
  form.max_retries = provider.connection.max_retries ?? 3
  form.version = provider.connection.version || '2023-06-01'
  form.client_version = provider.connection.client_version || '0.149.0'
  form.normalize_cch = provider.normalize_cch || false
  isModalOpen.value = true
}

function resetForm() {
  stopPolling()
  activeLogin.value = null
  nameTouched.value = false
  clearErrors()
  Object.assign(form, {
    name: '', display_name: '', protocol: 'openai', enabled: true,
    use_custom_models: false, custom_models: [], base_url: '', api_key: '',
    timeout: 30000, enable_timeout: true, max_retries: 3,
    version: '2023-06-01', normalize_cch: false, client_version: '0.149.0'
  })
}

async function closeModal() {
  if (activeLogin.value?.status === 'pending') await cancelActiveLogin()
  isModalOpen.value = false
  stopPolling()
}

async function startCodexLogin() {
  if (!validateBasics()) return
  startingLogin.value = true
  try {
    const models = form.use_custom_models ? form.custom_models.filter(model => model.id.trim()) : []
    activeLogin.value = await $fetch<LoginState>('/api/hub/providers/codex-login/start' as any, {
      method: 'POST',
      body: {
        name: form.name, display_name: form.display_name, enabled: form.enabled,
        normalize_cch: form.normalize_cch, timeout: form.timeout,
        enable_timeout: form.enable_timeout, max_retries: form.max_retries,
        use_custom_models: form.use_custom_models, models,
        client_version: form.client_version,
        reconnect: Boolean(editingProvider.value)
      }
    })
    loginNow.value = Date.now()
    schedulePoll()
  } catch (error: any) {
    showError(error, 'Unable to start ChatGPT login')
  } finally {
    startingLogin.value = false
  }
}

function schedulePoll() {
  stopPolling()
  pollTimer = setTimeout(pollLogin, 1500)
}

async function pollLogin() {
  if (!activeLogin.value || activeLogin.value.status !== 'pending') return
  loginNow.value = Date.now()
  try {
    const status = await $fetch<LoginState>(`/api/hub/providers/codex-login/${activeLogin.value.login_id}/poll` as any, { method: 'POST' })
    activeLogin.value = status
    if (status.status === 'completed') {
      toast.add({ title: 'ChatGPT connected', description: `${form.display_name} is ready to use.`, color: 'green', icon: 'i-heroicons-check-circle' })
      stopPolling()
      isModalOpen.value = false
      await loadProviders()
      return
    }
    if (status.status === 'failed') {
      stopPolling()
      return
    }
    schedulePoll()
  } catch (error: any) {
    if (error?.statusCode === 401) return navigateTo('/login')
    schedulePoll()
  }
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

async function cancelActiveLogin() {
  stopPolling()
  const login = activeLogin.value
  activeLogin.value = null
  if (!login) return
  await $fetch(`/api/hub/providers/codex-login/${login.login_id}` as any, { method: 'DELETE' }).catch(() => {})
}

function openVerificationPage() {
  if (activeLogin.value?.verification_url) window.open(activeLogin.value.verification_url, '_blank', 'noopener,noreferrer')
}

async function copyLoginCode() {
  if (!activeLogin.value) return
  await navigator.clipboard.writeText(activeLogin.value.user_code)
  toast.add({ title: 'Code copied', color: 'green', timeout: 1500 })
}

async function saveProvider() {
  if (!validateForm()) return
  saving.value = true
  try {
    const models = form.use_custom_models ? form.custom_models.filter(model => model.id.trim()) : []
    const body: any = {
      name: form.name, display_name: form.display_name, protocol: form.protocol,
      enabled: form.enabled, use_custom_models: form.use_custom_models,
      timeout: form.timeout, enable_timeout: form.enable_timeout,
      max_retries: form.max_retries, version: form.version,
      client_version: form.client_version,
      models, normalize_cch: form.normalize_cch
    }
    if (form.protocol !== 'codex-subscription') {
      body.base_url = form.base_url
      body.api_key = form.api_key
    }

    if (editingProvider.value) await $fetch(`/api/hub/providers/${form.name}`, { method: 'PUT', body })
    else await $fetch('/api/hub/providers', { method: 'POST', body })

    toast.add({ title: editingProvider.value ? 'Provider updated' : 'Provider added', color: 'green', icon: 'i-heroicons-check-circle' })
    isModalOpen.value = false
    await loadProviders()
  } catch (error: any) {
    if (error?.statusCode === 401) return navigateTo('/login')
    showError(error, 'Unable to save provider')
  } finally {
    saving.value = false
  }
}

async function deleteProvider(name: string) {
  if (!confirm(`Delete provider “${name}”?`)) return
  try {
    await $fetch(`/api/hub/providers/${name}`, { method: 'DELETE' })
    toast.add({ title: 'Provider deleted', color: 'green' })
    await loadProviders()
  } catch (error: any) {
    if (error?.statusCode === 401) return navigateTo('/login')
    showError(error, 'Unable to delete provider')
  }
}

function validateBasics(): boolean {
  clearErrors()
  if (!form.display_name.trim()) errors.display_name = 'Enter a display name'
  if (!form.name.trim()) errors.name = 'Enter a provider ID'
  else if (!/^[a-z0-9][a-z0-9_-]*$/.test(form.name)) errors.name = 'Use lowercase letters, numbers, _ or -'
  return !errors.display_name && !errors.name
}

function validateForm(): boolean {
  const basicsValid = validateBasics()
  if (form.protocol !== 'codex-subscription') {
    if (!form.base_url.trim()) errors.base_url = 'Enter the provider base URL'
    if (!editingProvider.value && !form.api_key.trim()) errors.api_key = 'Enter an API key'
  }
  return basicsValid && !errors.base_url && !errors.api_key
}

function clearErrors() {
  errors.name = ''
  errors.display_name = ''
  errors.base_url = ''
  errors.api_key = ''
}

function protocolLabel(protocol: Protocol): string {
  return protocolOptions.find(option => option.value === protocol)?.label || protocol
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

function showError(error: any, fallback: string) {
  const description = error?.data?.message
    || error?.data?.data?.error?.message
    || error?.statusMessage
    || error?.message
    || fallback
  toast.add({ title: fallback, description, color: 'red', icon: 'i-heroicons-exclamation-triangle' })
}
</script>
