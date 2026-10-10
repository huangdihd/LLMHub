<template>
  <UContainer class="py-8 max-w-5xl">
    <PageHeader title="Providers" description="Connect the accounts LLMHub uses to run model requests.">
      <UButton icon="i-heroicons-plus" @click="openAddModal">Add provider</UButton>
    </PageHeader>

    <UAlert v-if="providerTypesError" class="mb-4" color="amber" :title="providerTypesError" />

    <PageLoading v-if="loading" />

    <UCard v-else-if="providers.length === 0" class="text-center">
      <div class="py-10">
        <UIcon name="i-heroicons-link" class="w-10 h-10 mx-auto text-gray-300 dark:text-gray-600" />
        <h3 class="mt-4 font-medium text-gray-900 dark:text-white">No providers connected</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ dashboard.extensions.find(extension => extension.emptyDescription)?.emptyDescription || 'Add a provider to get started.' }}</p>
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
              <component :is="dashboard.extension(provider.protocol)?.badge" v-if="dashboard.extension(provider.protocol)?.badge" :provider="provider" />
            </div>
            <p v-if="provider.available === false" class="mt-2 text-sm text-amber-600 dark:text-amber-400">Unavailable: {{ provider.unavailableReason || 'Provider plugin is not active' }}</p>
            <div class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
              <span>{{ protocolLabel(provider.protocol) }}</span>
              <span class="font-mono text-xs">{{ provider.name }}</span>
              <span v-if="!isSubscriptionProtocol(provider.protocol)" class="break-all">{{ provider.connection.base_url }}</span>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <component :is="dashboard.extension(provider.protocol)?.actions" v-if="dashboard.extension(provider.protocol)?.actions" :provider="provider" :state="dashboard.state(provider.protocol)" />
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

        <component :is="dashboard.extension(provider.protocol)?.details" v-if="dashboard.extension(provider.protocol)?.details" :provider="provider" :state="dashboard.state(provider.protocol)" />
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

          <component :is="dashboard.extension(form.protocol)?.form" v-if="!isPluginProvider" :form="form" :errors="errors" :editing-provider="editingProvider" :state="dashboard.state(form.protocol)" />

          <section v-else class="space-y-4">
            <UAlert v-if="providerTypeUnavailable" color="amber" title="Provider type unavailable" description="Enable the plugin before editing this provider." />
            <PluginSchemaForm v-else :key="`${form.protocol}:${form.name}`" ref="schemaForm" v-model="form.extra" :fields="connectionSchema" :editing="!!editingProvider" />
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

              <component :is="dashboard.extension(form.protocol)?.advanced" v-if="dashboard.extension(form.protocol)?.advanced" :form="form" />

              <UCheckbox v-model="form.use_custom_models" label="Use a custom model list instead of fetching models" />
              <div v-if="form.use_custom_models" class="space-y-2 rounded-md bg-gray-50 dark:bg-gray-800/50 p-3">
                <div v-for="(model, index) in form.custom_models" :key="index" class="flex items-center gap-2">
                  <UInput v-model="model.id" placeholder="Model ID" class="flex-1" />
                  <UInput v-model="model.display_name" placeholder="Display name" class="flex-1" />
                  <UButton type="button" color="red" variant="ghost" icon="i-heroicons-trash" @click="form.custom_models.splice(index, 1)" />
                </div>
                <UButton type="button" color="gray" variant="soft" size="sm" @click="form.custom_models.push({ id: '', display_name: '' })">Add model</UButton>
              </div>

              <component :is="section.advanced" v-for="section in dashboard.sections" :key="section.id" :form="form" />
              <RuntimeContributionFields v-if="isModalOpen" :key="editorSession" ref="contributionFields" location="providers" :record-id="editingProvider?.name" />
            </div>
          </details>
        </form>

        <template #footer>
          <div class="flex justify-between gap-3">
            <UButton v-if="dashboard.pending()" color="red" variant="ghost" @click="dashboard.cancel">Cancel login</UButton>
            <span v-else />
            <div class="flex gap-2">
              <UButton color="gray" variant="ghost" :disabled="saving" @click="closeModal">Cancel</UButton>
              <UButton
                v-if="protocolChosen && (!isSubscriptionProtocol(form.protocol) || !!editingProvider)"
                :loading="saving"
                :disabled="dashboard.pending() || providerTypeUnavailable"
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
import { computed, onMounted, reactive, ref, watch } from 'vue'
import RuntimeContributionFields from '~/components/RuntimeContributionFields.vue'
import { useProviderDashboard } from '~/composables/useProviderDashboard'
import type { PluginField } from '~/shared/types/plugin'
import type { DashboardProviderForm, DashboardProviderRecord } from '~/shared/dashboard/providers'
type Protocol = string
type ProviderType = { id: string; displayName: string; connectionSchema?: PluginField[] }
const toast = useToast()
const providers = ref<DashboardProviderRecord[]>([])
const loading = ref(true)
const saving = ref(false)
const isModalOpen = ref(false)
const protocolChosen = ref(false)
const editingProvider = ref<DashboardProviderRecord | null>(null)
const nameTouched = ref(false)
const form = reactive<DashboardProviderForm>({ name: '', display_name: '', protocol: '', enabled: true, use_custom_models: false, custom_models: [], timeout: 30000, enable_timeout: true, max_retries: 3, extra: {} })
const errors = reactive<Record<string, string>>({ name: '', display_name: '', base_url: '', api_key: '' })
const dashboard = useProviderDashboard({ form, errors, editingProvider, isModalOpen, validateBasics, loadProviders, showError })
const builtinProtocolOptions = dashboard.extensions.map(extension => ({ value: extension.id, label: extension.label, description: extension.description, icon: extension.icon }))
Object.assign(form, dashboard.defaults)
form.protocol = dashboard.extensions[0]?.id || ''
const providerTypes = ref<ProviderType[]>([])
const providerTypesError = ref('')
const schemaForm = ref<{ validate: () => boolean } | null>(null)
const contributionFields = ref<InstanceType<typeof RuntimeContributionFields> | null>(null)
const editorSession = ref(0)
const createdProviderName = ref('')
const protocolOptions = computed(() => [
  ...builtinProtocolOptions,
  ...providerTypes.value.filter(provider => !builtinProtocolOptions.some(option => option.value === provider.id)).map(provider => ({
    value: provider.id, label: provider.displayName, description: 'Plugin provider', icon: 'i-heroicons-puzzle-piece'
  }))
])
const isPluginProvider = computed(() => !builtinProtocolOptions.some(option => option.value === form.protocol))
const connectionSchema = computed(() => providerTypes.value.find(provider => provider.id === form.protocol)?.connectionSchema || [])
const providerTypeUnavailable = computed(() => isPluginProvider.value && !providerTypes.value.some(provider => provider.id === form.protocol))

async function loadProviderTypes() {
  try {
    providerTypes.value = await $fetch<ProviderType[]>('/api/hub/provider-types')
    providerTypesError.value = ''
  } catch (error) {
    providerTypesError.value = 'Plugin provider types could not be loaded. Built-in providers are still available.'
    showError(error, 'Unable to load provider types')
  }
}

const modalTitle = computed(() => editingProvider.value ? `Edit ${editingProvider.value.display_name}` : 'Add provider')
watch(() => form.display_name, value => {
  if (!editingProvider.value && !nameTouched.value) form.name = slugify(value)
})

onMounted(() => { loadProviders(); loadProviderTypes() })
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
  const option = protocolOptions.value.find(item => item.value === protocol)!
  const extension = dashboard.extension(protocol)
  form.display_name = extension?.initial?.display_name || option.label
  form.name = extension?.initial?.name || slugify(form.display_name)
  Object.assign(form, { base_url: '' }, extension?.chooseDefaults)
  form.timeout = extension?.initial?.timeout || 30000
  nameTouched.value = false
  protocolChosen.value = true
}
function backToProtocolChoice() {
  if (dashboard.pending()) return
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
  form.timeout = provider.connection.timeout || 30000
  form.enable_timeout = provider.connection.enable_timeout ?? true
  form.max_retries = provider.connection.max_retries ?? 3
  dashboard.edit(provider)
  form.extra = {}
  // Copy only known non-secret fields, even when provider types are still loading.
  populatePluginFields()
  isModalOpen.value = true
}

function populatePluginFields() {
  if (!editingProvider.value || !isPluginProvider.value) return
  const stored = editingProvider.value.connection.extra || {}
  for (const field of connectionSchema.value) {
    if (field.type !== 'secret' && Object.hasOwn(stored, field.key) && !Object.hasOwn(form.extra, field.key)) {
      form.extra[field.key] = stored[field.key]
    }
  }
}

watch(connectionSchema, populatePluginFields)

function resetForm() {
  editorSession.value++
  createdProviderName.value = ''
  dashboard.reset()
  nameTouched.value = false
  clearErrors()
  Object.assign(form, dashboard.defaults, { name: '', display_name: '', protocol: dashboard.extensions[0]?.id || '', enabled: true, use_custom_models: false, custom_models: [], base_url: '', api_key: '', timeout: 30000, enable_timeout: true, max_retries: 3, extra: {} })
}
async function closeModal() {
  if (dashboard.pending()) await dashboard.cancel()
  isModalOpen.value = false
  dashboard.reset()
}
async function saveProvider() {
  if (saving.value) return
  if (isSubscriptionProtocol(form.protocol) && !editingProvider.value) return
  if (!validateForm() || !contributionFields.value?.validate()) return
  saving.value = true
  try {
    const models = form.use_custom_models ? form.custom_models.filter(model => model.id.trim()) : []
    const body: any = {
      name: form.name, display_name: form.display_name, protocol: form.protocol,
      enabled: form.enabled, use_custom_models: form.use_custom_models,
      timeout: form.timeout, enable_timeout: form.enable_timeout,
      max_retries: form.max_retries,
      models
    }
    Object.assign(body, dashboard.payload())
    if (isPluginProvider.value) body.connection = { extra: form.extra }

    if (editingProvider.value || createdProviderName.value) {
      await $fetch(`/api/hub/providers/${encodeURIComponent(createdProviderName.value || form.name)}`, { method: 'PUT', body })
    } else {
      await $fetch('/api/hub/providers', { method: 'POST', body })
      createdProviderName.value = form.name
    }
    await contributionFields.value.save(createdProviderName.value || form.name)

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
    dashboard.remove(name)
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
  if (providerTypeUnavailable.value) return false
  if (isPluginProvider.value) return (schemaForm.value?.validate() ?? false) && basicsValid
  return (dashboard.extension(form.protocol)?.validate?.({ form, errors, editingProvider, isModalOpen, validateBasics, loadProviders, showError }) ?? true) && basicsValid
}

function clearErrors() {
  errors.name = ''
  errors.display_name = ''
  errors.base_url = ''
  errors.api_key = ''
}

function isSubscriptionProtocol(protocol: Protocol): boolean {
  return Boolean(dashboard.extension(protocol)?.connectedLabel)
}
function protocolLabel(protocol: Protocol): string {
  return protocolOptions.value.find(option => option.value === protocol)?.label || protocol
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
