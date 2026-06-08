<template>
  <UContainer class="py-8 max-w-5xl">
    <div class="flex justify-between items-center mb-6">
      <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Provider Configuration</h2>
      <UButton color="primary" @click="openAddModal">Add Provider</UButton>
    </div>

    <div v-if="loading" class="flex justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 animate-spin text-gray-500" />
    </div>

    <div v-else class="space-y-6">
      <UCard v-for="provider in providers" :key="provider.name">
        <template #header>
          <div class="flex justify-between items-start">
            <div>
              <h3 class="text-lg font-medium text-gray-900 dark:text-white flex items-center gap-2">
                {{ provider.display_name }}
                <UBadge :color="provider.enabled ? 'green' : 'red'" variant="subtle" size="sm">
                  {{ provider.enabled ? 'Enabled' : 'Disabled' }}
                </UBadge>
                <UBadge v-if="provider.normalize_cch" color="blue" variant="subtle" size="sm">
                  CCH normalized
                </UBadge>
              </h3>
            </div>
            <div class="flex items-center space-x-2">
              <UButton color="gray" variant="ghost" icon="i-heroicons-pencil-square" @click="editProvider(provider)">Edit</UButton>
              <UButton color="red" variant="ghost" icon="i-heroicons-trash" @click="deleteProvider(provider.name)">Delete</UButton>
            </div>
          </div>
        </template>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm mb-4">
          <div>
            <span class="text-gray-500 dark:text-gray-400">Protocol:</span>
            <span class="ml-2 font-medium text-gray-900 dark:text-white capitalize">{{ provider.protocol }}</span>
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">Base URL:</span>
            <span class="ml-2 font-medium text-gray-900 dark:text-white">{{ provider.connection.base_url }}</span>
          </div>
          <div class="sm:col-span-2">
            <span class="text-gray-500 dark:text-gray-400">API Key:</span>
            <span class="ml-2 font-medium text-gray-900 dark:text-white">{{ provider.connection.api_key ? '••••••••••••••••' : 'Not set' }}</span>
          </div>
        </div>
      </UCard>
    </div>

    <!-- Modal -->
    <UModal v-model="isModalOpen">
      <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-base font-semibold leading-6 text-gray-900 dark:text-white">
              {{ editingProvider ? 'Edit Provider' : 'Add Provider' }}
            </h3>
            <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark-20-solid" class="-my-1" @click="closeModal" />
          </div>
        </template>

        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-4">
            <UFormGroup label="Name">
              <UInput v-model="form.name" :disabled="!!editingProvider" placeholder="openai" />
            </UFormGroup>
            <UFormGroup label="Display Name">
              <UInput v-model="form.display_name" placeholder="OpenAI" />
            </UFormGroup>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <UFormGroup label="Protocol">
              <USelect v-model="form.protocol" :options="[{ label: 'OpenAI', value: 'openai' }, { label: 'Claude', value: 'claude' }, { label: 'Gemini', value: 'gemini' }]" />
            </UFormGroup>
            <UFormGroup label="Status">
              <div class="flex items-center h-[32px]">
                <UToggle v-model="form.enabled" />
                <span class="ml-2 text-sm text-gray-700 dark:text-gray-300">{{ form.enabled ? 'Enabled' : 'Disabled' }}</span>
              </div>
            </UFormGroup>
          </div>

          <UCheckbox v-model="form.use_custom_models" label="Use custom model list (don't fetch from API)" />

          <div v-if="form.use_custom_models" class="space-y-2 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">Custom Models</label>
            <div v-for="(model, index) in form.custom_models" :key="index" class="flex items-center gap-2">
              <UInput v-model="model.id" placeholder="Model ID" class="flex-1" />
              <UInput v-model="model.display_name" placeholder="Display Name" class="flex-1" />
              <UButton color="red" variant="ghost" icon="i-heroicons-trash" @click="form.custom_models.splice(index, 1)" />
            </div>
            <UButton color="blue" variant="soft" size="sm" @click="form.custom_models.push({ id: '', display_name: '' })">
              + Add Model
            </UButton>
          </div>

          <UFormGroup label="Base URL">
            <UInput v-model="form.base_url" placeholder="https://api.openai.com/v1" />
          </UFormGroup>

          <UFormGroup label="API Key">
            <UInput v-model="form.api_key" type="password" placeholder="sk-..." />
          </UFormGroup>

          <div class="grid grid-cols-2 gap-4">
            <UFormGroup label="Timeout (ms)">
              <div class="flex items-center gap-2">
                <UInput v-model.number="form.timeout" type="number" class="flex-1" :disabled="!form.enable_timeout" />
                <UCheckbox v-model="form.enable_timeout" label="Enable" />
              </div>
            </UFormGroup>
            <UFormGroup label="Max Retries">
              <UInput v-model.number="form.max_retries" type="number" />
            </UFormGroup>
          </div>

          <UFormGroup v-if="form.protocol === 'claude'" label="API Version">
            <UInput v-model="form.version" placeholder="2023-06-01" />
          </UFormGroup>

          <UFormGroup v-if="form.protocol === 'claude'">
            <UCheckbox v-model="form.normalize_cch" label="Normalize cch in system prompt to 00000 (improves upstream cache hit rate)" />
          </UFormGroup>
        </div>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton color="gray" variant="ghost" @click="closeModal">Cancel</UButton>
            <UButton color="primary" @click="saveProvider" :loading="saving">Save</UButton>
          </div>
        </template>
      </UCard>
    </UModal>
  </UContainer>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'

const providers = ref<any[]>([])
const loading = ref(true)
const saving = ref(false)
const isModalOpen = ref(false)
const editingProvider = ref<any>(null)

const form = reactive({
  name: '',
  display_name: '',
  protocol: 'openai' as 'openai' | 'claude' | 'gemini',
  enabled: true,
  use_custom_models: false,
  custom_models: [] as { id: string; display_name: string }[],
  base_url: '',
  api_key: '',
  timeout: 30000,
  enable_timeout: true,
  max_retries: 3,
  version: '2023-06-01',
  normalize_cch: false
})

onMounted(async () => {
  await loadProviders()
})

async function loadProviders() {
  loading.value = true
  try {
    const data = await $fetch('/api/hub/providers')
    providers.value = data.providers
  } catch (error: any) {
    if (error?.statusCode === 401) return navigateTo('/login')
    console.error('Failed to load providers:', error)
  } finally {
    loading.value = false
  }
}

function openAddModal() {
  editingProvider.value = null
  resetForm()
  isModalOpen.value = true
}

function editProvider(provider: any) {
  editingProvider.value = provider
  form.name = provider.name
  form.display_name = provider.display_name
  form.protocol = provider.protocol
  form.enabled = provider.enabled
  form.use_custom_models = provider.use_custom_models || false
  form.custom_models = (provider.models || []).map((m: any) => ({ id: m.id, display_name: m.display_name }))
  form.base_url = provider.connection.base_url
  form.api_key = provider.connection.api_key
  form.timeout = provider.connection.timeout || 30000
  form.enable_timeout = provider.connection.enable_timeout ?? true
  form.max_retries = provider.connection.max_retries || 3
  form.version = provider.connection.version || '2023-06-01'
  form.normalize_cch = provider.normalize_cch || false
  isModalOpen.value = true
}

function resetForm() {
  form.name = ''
  form.display_name = ''
  form.protocol = 'openai'
  form.enabled = true
  form.use_custom_models = false
  form.custom_models = []
  form.base_url = ''
  form.api_key = ''
  form.timeout = 30000
  form.enable_timeout = true
  form.max_retries = 3
  form.version = '2023-06-01'
  form.normalize_cch = false
}

function closeModal() {
  isModalOpen.value = false
}

async function saveProvider() {
  saving.value = true
  try {
    const models = form.use_custom_models
      ? form.custom_models.filter(m => m.id.trim())
      : []

    const body = {
      name: form.name,
      display_name: form.display_name || form.name,
      protocol: form.protocol,
      enabled: form.enabled,
      use_custom_models: form.use_custom_models,
      base_url: form.base_url,
      api_key: form.api_key,
      timeout: form.timeout,
      enable_timeout: form.enable_timeout,
      max_retries: form.max_retries,
      version: form.version,
      models,
      normalize_cch: form.normalize_cch
    }

    if (editingProvider.value) {
      await $fetch(`/api/hub/providers/${form.name}`, {
        method: 'PUT',
        body
      })
    } else {
      await $fetch('/api/hub/providers', {
        method: 'POST',
        body
      })
    }

    closeModal()
    await loadProviders()
  } catch (error: any) {
    if (error?.statusCode === 401) return navigateTo('/login')
    console.error('Failed to save provider:', error)
    alert('Failed to save provider')
  } finally {
    saving.value = false
  }
}

async function deleteProvider(name: string) {
  if (!confirm(`Are you sure you want to delete provider "${name}"?`)) {
    return
  }

  try {
    await $fetch(`/api/hub/providers/${name}`, {
      method: 'DELETE'
    })
    await loadProviders()
  } catch (error: any) {
    if (error?.statusCode === 401) return navigateTo('/login')
    console.error('Failed to delete provider:', error)
    alert('Failed to delete provider')
  }
}
</script>
