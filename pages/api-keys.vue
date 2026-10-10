<template>
  <UContainer class="py-8 max-w-5xl">
    <PageHeader title="API keys" description="Keys your clients use to call the gateway, with their limits and access rules.">
      <UButton icon="i-heroicons-plus" @click="openCreateModal">Create key</UButton>
    </PageHeader>

    <PageLoading v-if="loading" />

    <UCard v-else-if="keys.length === 0">
      <EmptyState icon="i-heroicons-key" title="No API keys yet" description="Create a key to start sending requests through the gateway.">
        <UButton @click="openCreateModal">Create your first key</UButton>
      </EmptyState>
    </UCard>

    <div v-else class="space-y-4">
      <UCard v-for="key in keys" :key="key.id">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="text-lg font-medium text-gray-900 dark:text-white truncate">{{ key.name }}</h3>
              <component v-for="section in dashboard.sections('badge')" :key="section.id" :is="section.component" v-bind="section.props(key)" />
            </div>
            <component v-for="section in dashboard.sections('summary')" :key="section.id" :is="section.component" v-bind="section.props(key)" />
            <RuntimeApiKeySummary :record-id="key.id" :revision="contributionRevision" />
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <UButton color="gray" variant="soft" class="dark:!bg-gray-800 dark:!text-gray-100 dark:hover:!bg-gray-700" icon="i-heroicons-pencil-square" @click="openEditModal(key)">Edit</UButton>
            <UButton color="red" variant="ghost" icon="i-heroicons-trash" @click="deleteKey(key)">Delete</UButton>
          </div>
        </div>

        <component v-for="section in dashboard.sections('meter')" :key="section.id" :is="section.component" v-bind="section.props(key)" />

        <div class="mt-4 space-y-3 text-sm">
          <component v-for="section in dashboard.sections('details')" :key="section.id" :is="section.component" v-bind="section.props(key)" />
        </div>
      </UCard>
    </div>

    <!-- Create / Edit Modal -->
    <UModal v-model="isModalOpen" :ui="{ width: 'max-w-2xl' }">
      <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-base font-semibold text-gray-900 dark:text-white">
              {{ editingKey ? 'Edit API key' : 'Create API key' }}
            </h3>
            <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark-20-solid" @click="closeModal" />
          </div>
        </template>

        <div class="space-y-6">
          <!-- Name -->
          <UFormGroup label="Name" help="A label to recognise this key by.">
            <UInput v-model="form.name" placeholder="e.g. Cursor, Continue, My Project" />
          </UFormGroup>

          <component v-for="section in dashboard.sections('editor')" :key="section.id" :is="section.component" v-bind="section.props()" />

          <RuntimeContributionFields v-if="isModalOpen" :key="editorSession" ref="contributionFields" location="apiKeys" :record-id="editingKey?.id" />

          <!-- Newly created key -->
          <div v-if="newKeyPlain" class="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
            <p class="text-sm font-medium text-green-800 dark:text-green-300 mb-2">Copy your new key now. It won't be shown again.</p>
            <div class="flex items-center gap-2">
              <code class="text-sm font-mono bg-white dark:bg-gray-800 px-3 py-2 rounded flex-1 select-all break-all">{{ newKeyPlain }}</code>
              <UButton size="xs" icon="i-heroicons-clipboard-document" @click="copyKey">Copy</UButton>
            </div>
          </div>
        </div>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton color="gray" variant="ghost" @click="closeModal">Cancel</UButton>
            <UButton v-if="!newKeyPlain || contributionSaveFailed" color="primary" @click="saveKey" :loading="saving">Save</UButton>
            <UButton v-else color="primary" @click="closeModal">Done</UButton>
          </div>
        </template>
      </UCard>
    </UModal>
  </UContainer>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import RuntimeContributionFields from '~/components/RuntimeContributionFields.vue'
import RuntimeApiKeySummary from '~/components/RuntimeApiKeySummary.vue'

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
const contributionFields = ref<InstanceType<typeof RuntimeContributionFields> | null>(null)
const contributionRevision = ref(0)
const editorSession = ref(0)
const createdKeyId = ref('')
const contributionSaveFailed = ref(false)

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
  contributionRevision.value++
  const data = await $fetch('/api/hub/keys')
  keys.value = data.keys as ApiKeyDashboardRecord[] || []
}

function openCreateModal() {
  editorSession.value++
  createdKeyId.value = ''
  contributionSaveFailed.value = false
  editingKey.value = null
  resetForm()
  newKeyPlain.value = ''
  isModalOpen.value = true
}

function openEditModal(key: ApiKeyDashboardRecord) {
  editorSession.value++
  createdKeyId.value = ''
  contributionSaveFailed.value = false
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
  if (saving.value || !contributionFields.value?.validate()) return
  saving.value = true
  contributionSaveFailed.value = false
  try {
    const payload = { name: form.name, ...dashboard.payload() }

    if (editingKey.value) {
      await $fetch(`/api/hub/keys/${editingKey.value.id}`, { method: 'PUT', body: payload })
      await contributionFields.value.save(editingKey.value.id)
      closeModal()
      await loadKeys()
    } else {
      if (!createdKeyId.value) {
        const response = await $fetch('/api/hub/keys', { method: 'POST', body: { name: form.name } })
        newKeyPlain.value = (response as any).key?.plain_key || ''
        createdKeyId.value = (response as any).key?.id || ''
      }
      const id = createdKeyId.value
      if (id) {
        await $fetch(`/api/hub/keys/${id}`, { method: 'PUT', body: payload })
        await contributionFields.value.save(id)
      }
    }
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
    contributionSaveFailed.value = true
    toast.add({ title: 'Error', description: e?.message || 'Failed to save key', color: 'red' })
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
