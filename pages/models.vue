<template>
  <UContainer class="py-8 max-w-5xl">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Model List</h2>
        <p class="text-gray-500 dark:text-gray-400 mt-1">{{ totalModels }} models across {{ providerGroups.length }} providers</p>
      </div>
      <UInput
        v-model="search"
        icon="i-heroicons-magnifying-glass-20-solid"
        placeholder="Search models..."
        class="w-64"
      />
    </div>

    <div v-if="loading" class="flex justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 animate-spin text-gray-500" />
    </div>

    <div v-else-if="filteredGroups.length === 0" class="text-center py-12">
      <UIcon name="i-heroicons-cpu-chip" class="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
      <p class="text-gray-500 dark:text-gray-400">
        {{ search ? 'No models matching your search.' : 'No models found.' }}
      </p>
    </div>

    <div v-else class="space-y-4">
      <UCard v-for="group in filteredGroups" :key="group.provider">
        <template #header>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
                <UIcon name="i-heroicons-server-stack" class="w-5 h-5" />
              </div>
              <div>
                <h3 class="text-lg font-semibold text-gray-900 dark:text-white">{{ getProviderDisplayName(group.provider) }}</h3>
                <p class="text-sm text-gray-500 dark:text-gray-400">{{ group.models.length }} model{{ group.models.length !== 1 ? 's' : '' }}</p>
              </div>
            </div>
            <UBadge color="blue" variant="subtle">{{ group.models.length }}</UBadge>
          </div>
        </template>

        <div class="divide-y divide-gray-100 dark:divide-gray-800">
          <div
            v-for="model in group.models"
            :key="model.id"
            class="flex items-center justify-between py-3 first:pt-0 last:pb-0 px-2 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded transition-colors"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <code class="text-sm font-mono font-medium text-gray-900 dark:text-white bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
                  {{ model.id }}
                </code>
                <span class="text-sm text-gray-500 dark:text-gray-400">{{ model.display_name }}</span>
              </div>
            </div>

            <div class="flex items-center gap-2 ml-4 flex-shrink-0">
              <UTooltip v-if="model.capabilities?.tools" text="Tool Calling">
                <UBadge color="green" variant="soft" size="xs">
                  <UIcon name="i-heroicons-wrench-screwdriver" class="w-3 h-3 mr-0.5" />
                  Tools
                </UBadge>
              </UTooltip>
              <UTooltip v-if="model.capabilities?.vision" text="Vision / Multimodal">
                <UBadge color="purple" variant="soft" size="xs">
                  <UIcon name="i-heroicons-photo" class="w-3 h-3 mr-0.5" />
                  Vision
                </UBadge>
              </UTooltip>
              <UTooltip v-if="model.capabilities?.streaming !== false" text="Streaming Support">
                <UBadge color="cyan" variant="soft" size="xs">
                  <UIcon name="i-heroicons-bolt" class="w-3 h-3 mr-0.5" />
                  Stream
                </UBadge>
              </UTooltip>
              <UButton
                color="gray"
                variant="ghost"
                size="xs"
                icon="i-heroicons-clipboard-document"
                @click="copyModelId(model.id)"
              />
            </div>
          </div>
        </div>
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
const search = ref('')
const providerDisplayNames = ref<Record<string, string>>({})

interface ModelGroup {
  provider: string
  models: any[]
}

onMounted(async () => {
  try {
    const [modelsData, providersData] = await Promise.all([
      $fetch('/api/hub/models'),
      $fetch('/api/hub/providers').catch(() => ({ providers: [] }))
    ])
    models.value = (modelsData as any).models || []

    const providers = (providersData as any).providers || []
    const nameMap: Record<string, string> = {}
    for (const p of providers) {
      nameMap[p.name] = p.display_name || p.name
    }
    providerDisplayNames.value = nameMap
  } catch (error) {
    console.error('Failed to load models:', error)
  } finally {
    loading.value = false
  }
})

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
