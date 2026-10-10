<template>
  <UContainer class="py-8 max-w-5xl">
    <PageHeader title="Models">
      <template #description>
        {{ totalModels }} model{{ totalModels !== 1 ? 's' : '' }} across {{ providerGroups.length }} provider{{ providerGroups.length !== 1 ? 's' : '' }}.
        <component v-for="section in dashboard.sections('description')" :key="section.id" :is="section.component" v-bind="section.props()" />
      </template>
      <UTooltip text="Refresh from providers">
        <UButton color="gray" variant="ghost" icon="i-heroicons-arrow-path" aria-label="Refresh from providers" :loading="refreshing" @click="refreshModels" />
      </UTooltip>
      <UInput v-model="search" icon="i-heroicons-magnifying-glass-20-solid" placeholder="Search models" class="w-full sm:w-64" />
    </PageHeader>

    <PageLoading v-if="loading" />

    <UCard v-else-if="filteredGroups.length === 0">
      <EmptyState icon="i-heroicons-cpu-chip" :title="search ? 'No models match your search' : 'No models found'" :description="search ? 'Try a different search term.' : 'Connect a provider to see its models here.'" />
    </UCard>

    <div v-else class="space-y-4">
      <UCard v-for="group in filteredGroups" :key="group.provider" :ui="{ body: { padding: '' }, header: { padding: 'px-4 py-3.5 sm:px-6' } }">
        <template #header>
          <div class="flex items-center justify-between gap-4">
            <h3 class="font-medium text-gray-900 dark:text-white truncate">{{ getProviderDisplayName(group.provider) }}</h3>
            <span class="text-sm tabular-nums text-gray-500 dark:text-gray-400 flex-shrink-0">{{ group.models.length }} model{{ group.models.length !== 1 ? 's' : '' }}</span>
          </div>
        </template>

        <ul class="divide-y divide-gray-100 dark:divide-gray-800">
          <li
            v-for="model in group.models"
            :key="model.id"
            class="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-6 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
          >
            <div class="min-w-0">
              <p class="font-mono text-sm text-gray-900 dark:text-white break-all">{{ model.id }}</p>
              <p v-if="model.display_name && model.display_name !== model.id" class="mt-0.5 text-xs text-gray-500 dark:text-gray-400 truncate">{{ model.display_name }}</p>
            </div>

            <div class="flex items-center gap-3 flex-wrap flex-shrink-0">
              <div class="flex items-center gap-1.5 text-gray-400 dark:text-gray-500">
                <UTooltip v-if="model.capabilities?.tools" text="Tool calling"><UIcon name="i-heroicons-wrench-screwdriver" class="w-4 h-4" /></UTooltip>
                <UTooltip v-if="model.capabilities?.vision" text="Vision"><UIcon name="i-heroicons-photo" class="w-4 h-4" /></UTooltip>
                <UTooltip v-if="model.capabilities?.streaming !== false" text="Streaming"><UIcon name="i-heroicons-bolt" class="w-4 h-4" /></UTooltip>
              </div>
              <component v-for="section in dashboard.sections('model-actions')" :key="section.id" :is="section.component" v-bind="section.props(model)" />
              <UTooltip text="Copy model ID">
                <UButton color="gray" variant="ghost" size="xs" icon="i-heroicons-clipboard-document" aria-label="Copy model ID" @click="copyModelId(model.id)" />
              </UTooltip>
            </div>
          </li>
        </ul>
      </UCard>
    </div>

    <UNotifications />
  </UContainer>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

const toast = useToast()
const models = ref<any[]>([])
const loading = ref(true)
const refreshing = ref(false)
const search = ref('')
const providerDisplayNames = ref<Record<string, string>>({})
const dashboard = useDashboardSections('models')

interface ModelGroup {
  provider: string
  models: any[]
}

onMounted(async () => {
  await loadAll()
})

async function loadModels() {
  try {
    const data = await $fetch('/api/hub/models')
    models.value = ((data as any).models || []).map(dashboard.decorate)
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
    throw e
  }
}

async function loadAll() {
  try {
    const [providersData, modelsData] = await Promise.all([
      $fetch('/api/hub/providers').catch(() => ({ providers: [] })),
      $fetch('/api/hub/models'),
      dashboard.load()
    ])

    models.value = ((modelsData as any).models || []).map(dashboard.decorate)
    const providers = (providersData as any).providers || []
    const nameMap: Record<string, string> = {}
    for (const p of providers) {
      nameMap[p.name] = p.display_name || p.name
    }
    providerDisplayNames.value = nameMap
  } catch (error: any) {
    if (error?.statusCode === 401) return navigateTo('/login')
    console.error('Failed to load models:', error)
  } finally {
    loading.value = false
  }
}

async function refreshModels() {
  refreshing.value = true
  try {
    await $fetch('/api/hub/models/refresh', { method: 'POST' })
    await loadModels()
    toast.add({ title: 'Refreshed', description: 'Model list updated from providers', icon: 'i-heroicons-check-circle', color: 'green', timeout: 2000 })
  } catch (e) {
    toast.add({ title: 'Refresh failed', color: 'red', timeout: 2000 })
  } finally {
    refreshing.value = false
  }
}

function getProviderDisplayName(providerName: string): string {
  return providerDisplayNames.value[providerName] || providerName
}

const totalModels = computed(() => models.value.length)

const providerGroups = computed<ModelGroup[]>(() => {
  const groups: Record<string, any[]> = {}
  for (const model of models.value) {
    const provider = model.provider || 'unknown'
    if (!groups[provider]) groups[provider] = []
    groups[provider].push(model)
  }
  return Object.entries(groups)
    .map(([provider, modelList]) => ({ provider, models: modelList }))
    .sort((a, b) => a.provider.localeCompare(b.provider))
})

const filteredGroups = computed(() => {
  if (!search.value.trim()) return providerGroups.value
  const q = search.value.toLowerCase()
  return providerGroups.value
    .map(group => ({
      ...group,
      models: group.models.filter(m =>
        m.id.toLowerCase().includes(q) ||
        m.display_name.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        group.provider.toLowerCase().includes(q)
      )
    }))
    .filter(group => group.models.length > 0)
})

async function copyModelId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    toast.add({ title: 'Copied', description: id, icon: 'i-heroicons-check-circle', color: 'green', timeout: 2000 })
  } catch {
    toast.add({ title: 'Failed to copy', description: id, color: 'red', timeout: 2000 })
  }
}
</script>
