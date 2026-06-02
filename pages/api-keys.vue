<template>
  <UContainer class="py-8 max-w-4xl">
    <div class="flex justify-between items-center mb-6">
      <div>
        <h2 class="text-2xl font-bold text-gray-900 dark:text-white">API Keys</h2>
        <p class="text-gray-500 dark:text-gray-400 mt-1">Manage API keys for LLM endpoint access</p>
      </div>
      <UButton color="primary" icon="i-heroicons-plus" @click="openCreateModal">Create Key</UButton>
    </div>

    <div v-if="loading" class="flex justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 animate-spin text-gray-500" />
    </div>

    <div v-else class="space-y-4">
      <UCard v-for="key in keys" :key="key.id">
        <template #header>
          <div class="flex justify-between items-center">
            <div class="flex items-center gap-2">
              <h3 class="text-lg font-medium text-gray-900 dark:text-white">{{ key.name }}</h3>
              <UBadge v-if="key.monthly_limit > 0" :color="key.tokens_used >= key.monthly_limit ? 'red' : 'green'" variant="soft">
                {{ key.tokens_used.toLocaleString() }} / {{ key.monthly_limit.toLocaleString() }} tokens
              </UBadge>
              <UBadge v-else color="gray" variant="soft">Unlimited</UBadge>
            </div>
            <div class="flex items-center gap-2">
              <UButton color="gray" variant="ghost" icon="i-heroicons-pencil-square" @click="openEditModal(key)">Edit</UButton>
              <UButton color="red" variant="ghost" icon="i-heroicons-trash" @click="deleteKey(key)">Delete</UButton>
            </div>
          </div>
        </template>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm mb-4">
          <div>
            <span class="text-gray-500 dark:text-gray-400">Calls:</span>
            <span class="ml-2 font-medium text-gray-900 dark:text-white">{{ key.call_count }}</span>
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">Tokens used:</span>
            <span class="ml-2 font-medium text-gray-900 dark:text-white">{{ key.tokens_used.toLocaleString() }}</span>
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">Created:</span>
            <span class="ml-2 font-medium text-gray-900 dark:text-white">{{ new Date(key.created_at).toLocaleDateString() }}</span>
          </div>
        </div>

        <div v-if="key.monthly_limit > 0" class="mb-3">
          <div class="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              class="h-full rounded-full transition-all"
              :class="key.tokens_used >= key.monthly_limit ? 'bg-red-500' : 'bg-primary'"
              :style="{ width: Math.min(100, key.tokens_used / key.monthly_limit * 100) + '%' }"
            />
          </div>
        </div>

        <div class="space-y-2 text-sm">
          <div v-if="key.allowed_providers.length > 0">
            <span class="text-gray-500 dark:text-gray-400">Providers:</span>
            <div class="flex flex-wrap gap-1 mt-1">
              <UBadge v-for="p in key.allowed_providers" :key="p" color="blue" variant="soft">{{ p }}</UBadge>
            </div>
          </div>
          <div v-if="key.allowed_models.length > 0">
            <span class="text-gray-500 dark:text-gray-400">Models:</span>
            <div class="flex flex-wrap gap-1 mt-1">
              <UBadge v-for="m in key.allowed_models" :key="m" color="purple" variant="soft">{{ m }}</UBadge>
            </div>
          </div>
          <p v-if="key.allowed_providers.length === 0 && key.allowed_models.length === 0" class="text-gray-400 italic">
            Access to all providers and models
          </p>
        </div>
      </UCard>

      <div v-if="keys.length === 0" class="text-center py-12 text-gray-500">
        <UIcon name="i-heroicons-key" class="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
        <p>No API keys yet.</p>
        <p class="text-sm mt-1">Create a key to start using the LLM proxy endpoints.</p>
      </div>
    </div>

    <!-- Create / Edit Modal -->
    <UModal v-model="isModalOpen">
      <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-base font-semibold text-gray-900 dark:text-white">
              {{ editingKey ? 'Edit API Key' : 'Create API Key' }}
            </h3>
            <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark-20-solid" @click="closeModal" />
          </div>
        </template>

        <div class="space-y-4">
          <UFormGroup label="Name">
            <UInput v-model="form.name" placeholder="e.g. Cursor, Continue" />
          </UFormGroup>

          <UFormGroup label="Monthly token limit (0 = unlimited)">
            <UInput v-model.number="form.monthly_limit" type="number" min="0" />
          </UFormGroup>

          <UFormGroup label="Allowed providers (comma-separated, empty = all)">
            <UInput v-model="form.providersRaw" placeholder="deepseek, mimo" />
          </UFormGroup>

          <UFormGroup label="Allowed models (comma-separated, empty = all)">
            <UInput v-model="form.modelsRaw" placeholder="deepseek/deepseek-chat, mimo/mimo-v2.5" />
          </UFormGroup>

          <!-- Show newly created key -->
          <div v-if="newKeyPlain" class="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
            <p class="text-sm font-medium text-green-800 dark:text-green-300 mb-2">Your new API key (copy now — it won't be shown again):</p>
            <div class="flex items-center gap-2">
              <code class="text-sm font-mono bg-white dark:bg-gray-800 px-3 py-2 rounded flex-1 select-all break-all">{{ newKeyPlain }}</code>
              <UButton size="xs" icon="i-heroicons-clipboard-document" @click="copyKey">Copy</UButton>
            </div>
          </div>
        </div>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton color="gray" variant="ghost" @click="closeModal">Cancel</UButton>
            <UButton v-if="!newKeyPlain" color="primary" @click="saveKey" :loading="saving">Save</UButton>
            <UButton v-else color="primary" @click="closeModal">Done</UButton>
          </div>
        </template>
      </UCard>
    </UModal>
  </UContainer>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'

const toast = useToast()
const keys = ref<any[]>([])
const loading = ref(true)
const saving = ref(false)
const isModalOpen = ref(false)
const editingKey = ref<any>(null)
const newKeyPlain = ref('')

const form = reactive({
  name: '',
  monthly_limit: 0,
  providersRaw: '',
  modelsRaw: ''
})

onMounted(async () => {
  try {
    await loadKeys()
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
  } finally {
    loading.value = false
  }
})

async function loadKeys() {
  const data = await $fetch('/api/hub/keys')
  keys.value = (data as any).keys || []
}

function openCreateModal() {
  editingKey.value = null
  resetForm()
  newKeyPlain.value = ''
  isModalOpen.value = true
}

function openEditModal(key: any) {
  editingKey.value = key
  form.name = key.name
  form.monthly_limit = key.monthly_limit || 0
  form.providersRaw = key.allowed_providers?.join(', ') || ''
  form.modelsRaw = key.allowed_models?.join(', ') || ''
  newKeyPlain.value = ''
  isModalOpen.value = true
}

function resetForm() {
  form.name = ''
  form.monthly_limit = 0
  form.providersRaw = ''
  form.modelsRaw = ''
}

function closeModal() {
  isModalOpen.value = false
  if (newKeyPlain.value) loadKeys()
  newKeyPlain.value = ''
}

function parseComma(s: string): string[] {
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

async function saveKey() {
  saving.value = true
  try {
    const payload = {
      name: form.name,
      monthly_limit: form.monthly_limit,
      allowed_providers: parseComma(form.providersRaw),
      allowed_models: parseComma(form.modelsRaw)
    }

    if (editingKey.value) {
      await $fetch(`/api/hub/keys/${editingKey.value.id}`, { method: 'PUT', body: payload })
      closeModal()
      await loadKeys()
    } else {
      const res = await $fetch('/api/hub/keys', { method: 'POST', body: { name: form.name } })
      newKeyPlain.value = (res as any).key?.plain_key || ''
      // Apply remaining settings via PUT
      if (newKeyPlain.value) {
        const id = (res as any).key?.id
        if (id) {
          await $fetch(`/api/hub/keys/${id}`, { method: 'PUT', body: payload })
        }
      }
    }
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
    toast.add({ title: 'Error', description: 'Failed to save key', color: 'red' })
  } finally {
    saving.value = false
  }
}

async function deleteKey(key: any) {
  if (!confirm(`Delete API key "${key.name}"?`)) return
  try {
    await $fetch(`/api/hub/keys/${key.id}`, { method: 'DELETE' })
    await loadKeys()
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
    toast.add({ title: 'Error', description: 'Failed to delete key', color: 'red' })
  }
}

function copyKey() {
  navigator.clipboard.writeText(newKeyPlain.value).then(() => {
    toast.add({ title: 'Copied!', icon: 'i-heroicons-check-circle', color: 'green', timeout: 2000 })
  })
}
</script>
