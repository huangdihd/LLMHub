<template>
  <UContainer class="py-8 max-w-4xl">
    <div class="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
      <div>
        <h2 class="text-2xl font-bold text-gray-900 dark:text-white">API Keys</h2>
        <p class="text-gray-500 dark:text-gray-400 mt-1">Manage API keys for LLM endpoint access</p>
      </div>
      <UButton color="primary" icon="i-heroicons-plus" class="self-start sm:self-auto" @click="openCreateModal">Create Key</UButton>
    </div>

    <div v-if="loading" class="flex justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 animate-spin text-gray-500" />
    </div>

    <div v-else class="space-y-4">
      <UCard v-for="key in keys" :key="key.id">
        <template #header>
          <div class="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
            <div class="flex items-center gap-2 flex-wrap min-w-0">
              <h3 class="text-lg font-medium text-gray-900 dark:text-white truncate">{{ key.name }}</h3>
              <component v-for="section in dashboard.sections('badge')" :key="section.id" :is="section.component" v-bind="section.props(key)" />
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <UButton color="gray" variant="ghost" icon="i-heroicons-pencil-square" @click="openEditModal(key)">Edit</UButton>
              <UButton color="red" variant="ghost" icon="i-heroicons-trash" @click="deleteKey(key)">Delete</UButton>
            </div>
          </div>
        </template>

        <component v-for="section in dashboard.sections('summary')" :key="section.id" :is="section.component" v-bind="section.props(key)" />
        <component v-for="section in dashboard.sections('meter')" :key="section.id" :is="section.component" v-bind="section.props(key)" />

        <div class="space-y-2 text-sm">
          <component v-for="section in dashboard.sections('details')" :key="section.id" :is="section.component" v-bind="section.props(key)" />
        </div>
      </UCard>

      <div v-if="keys.length === 0" class="text-center py-12 text-gray-500">
        <UIcon name="i-heroicons-key" class="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
        <p>No API keys yet.</p>
        <p class="text-sm mt-1">Create a key to start using the LLM proxy endpoints.</p>
      </div>
    </div>

    <!-- Create / Edit Modal -->
    <UModal v-model="isModalOpen" :ui="{ width: 'max-w-2xl' }">
      <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-base font-semibold text-gray-900 dark:text-white">
              {{ editingKey ? 'Edit API Key' : 'Create API Key' }}
            </h3>
            <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark-20-solid" @click="closeModal" />
          </div>
        </template>

        <div class="space-y-6">
          <!-- Name -->
          <UFormGroup label="Name" help="A descriptive label for this key">
            <UInput v-model="form.name" placeholder="e.g. Cursor, Continue, My Project" />
          </UFormGroup>

          <component v-for="section in dashboard.sections('editor')" :key="section.id" :is="section.component" v-bind="section.props()" />

          <!-- Newly created key -->
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

import type { ApiKeyDashboardRecord } from '~/shared/dashboard/api-keys'

const dashboard = useApiKeyDashboard()
const toast = useToast()
const keys = ref<ApiKeyDashboardRecord[]>([])
const loading = ref(true)
const saving = ref(false)
const isModalOpen = ref(false)
const editingKey = ref<ApiKeyDashboardRecord | null>(null)
const newKeyPlain = ref('')

const form = reactive({ name: '' })

onMounted(async () => {
  try {
    const [data] = await Promise.all([$fetch('/api/hub/keys'), dashboard.load()])
    keys.value = data.keys as ApiKeyDashboardRecord[] || []
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
  } finally {
    loading.value = false
  }
})

async function loadKeys() {
  const data = await $fetch('/api/hub/keys')
  keys.value = data.keys as ApiKeyDashboardRecord[] || []
}

function openCreateModal() {
  editingKey.value = null
  resetForm()
  newKeyPlain.value = ''
  isModalOpen.value = true
}

function openEditModal(key: ApiKeyDashboardRecord) {
  editingKey.value = key
  form.name = key.name
  dashboard.reset(key)

  newKeyPlain.value = ''
  isModalOpen.value = true
}

function resetForm() {
  form.name = ''
  dashboard.reset()
}

function closeModal() {
  isModalOpen.value = false
  if (newKeyPlain.value) loadKeys()
  newKeyPlain.value = ''
}

async function saveKey() {
  saving.value = true
  try {
    const payload = { name: form.name, ...dashboard.payload() }

    if (editingKey.value) {
      await $fetch(`/api/hub/keys/${editingKey.value.id}`, { method: 'PUT', body: payload })
      closeModal()
      await loadKeys()
    } else {
      const res = await $fetch('/api/hub/keys', { method: 'POST', body: { name: form.name } })
      newKeyPlain.value = (res as any).key?.plain_key || ''
      const id = (res as any).key?.id
      if (id) {
        await $fetch(`/api/hub/keys/${id}`, { method: 'PUT', body: payload })
      }
    }
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
    toast.add({ title: 'Error', description: 'Failed to save key', color: 'red' })
  } finally {
    saving.value = false
  }
}

async function deleteKey(key: ApiKeyDashboardRecord) {
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
