<template>
  <UContainer class="py-8 max-w-6xl">
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
      <div>
        <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h2>
        <p class="text-gray-500 dark:text-gray-400 mt-1">Overview of your LLMHub gateway</p>
      </div>
      <div class="flex flex-wrap gap-3">
        <UButton to="/providers" icon="i-heroicons-cog-6-tooth" color="gray" variant="solid">Manage Providers</UButton>
        <component v-for="(contribution, index) in contributions.filter(item => item.action)" :is="contribution.action" :key="index" />
      </div>
    </div>

    <!-- Quick Stats -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 mb-8">
      <component v-for="(contribution, index) in contributions.filter(item => item.metric)" :is="contribution.metric" :key="index" :loading="loading" v-bind="contribution.metricProps()" />
      
      <UCard :ui="{ body: { padding: 'p-6 sm:p-6' } }">
        <div class="flex items-center">
          <div class="p-3 rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
            <UIcon name="i-heroicons-server-stack" class="w-6 h-6" />
          </div>
          <div class="ml-4">
            <p class="text-sm font-medium text-gray-500 dark:text-gray-400">Active Providers</p>
            <div class="flex items-baseline mt-1">
              <h3 class="text-2xl font-bold text-gray-900 dark:text-white">
                {{ loading ? '-' : activeProvidersCount }}
              </h3>
              <span class="ml-2 text-sm text-gray-500">/ {{ loading ? '-' : totalProvidersCount }} total</span>
            </div>
          </div>
        </div>
      </UCard>

      <UCard :ui="{ body: { padding: 'p-6 sm:p-6' } }">
        <div class="flex items-center">
          <div class="p-3 rounded-lg bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">
            <UIcon name="i-heroicons-cpu-chip" class="w-6 h-6" />
          </div>
          <div class="ml-4">
            <p class="text-sm font-medium text-gray-500 dark:text-gray-400">Available Models</p>
            <h3 class="text-2xl font-bold text-gray-900 dark:text-white mt-1">
              {{ loading ? '-' : totalModelsCount }}
            </h3>
          </div>
        </div>
      </UCard>

      <UCard :ui="{ body: { padding: 'p-6 sm:p-6' } }">
        <div class="flex items-center">
          <div class="p-3 rounded-lg bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400">
            <UIcon name="i-heroicons-arrows-right-left" class="w-6 h-6" />
          </div>
          <div class="ml-4">
            <p class="text-sm font-medium text-gray-500 dark:text-gray-400">Active Protocols</p>
            <h3 class="text-2xl font-bold text-gray-900 dark:text-white mt-1">
              {{ loading ? '-' : Object.keys(protocolCounts).length }}
            </h3>
            <p class="text-xs text-gray-500 mt-1 uppercase truncate w-24" :title="Object.keys(protocolCounts).join(', ')">
              {{ loading ? '...' : Object.keys(protocolCounts).join(', ') || 'None' }}
            </p>
          </div>
        </div>
      </UCard>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- API Key Usage -->
      <div class="lg:col-span-2 space-y-6">
        <component v-for="(contribution, index) in contributions.filter(item => item.usage)" :is="contribution.usage" :key="index" v-bind="contribution.usageProps()" />
      </div>

      <!-- Quick Actions / Status -->
      <div class="space-y-6">
        <UCard>
          <template #header>
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-medium text-gray-900 dark:text-white">Models Breakdown</h3>
              <UButton color="gray" variant="ghost" size="xs" icon="i-heroicons-arrow-path" :loading="refreshing" @click="refreshModels" />
            </div>
          </template>
          
          <ul v-if="!loading && Object.keys(modelsByProvider).length > 0" class="space-y-3 text-sm">
            <li v-for="(count, provider) in modelsByProvider" :key="provider" class="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded">
              <span class="text-gray-700 dark:text-gray-300 capitalize flex items-center gap-2">
                <UIcon name="i-heroicons-server" class="w-4 h-4 text-gray-400" />
                {{ getProviderDisplayName(provider) }}
              </span>
              <UBadge color="blue" variant="soft">{{ count }} model{{ count !== 1 ? 's' : '' }}</UBadge>
            </li>
          </ul>
          <div v-else-if="loading" class="text-center py-4">
             <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 animate-spin text-gray-400 mx-auto" />
          </div>
          <div v-else class="text-center py-4 text-sm text-gray-500">
            No models found.
          </div>
        </UCard>

        <component v-for="(contribution, index) in contributions.filter(item => item.endpoint)" :is="contribution.endpoint" :key="index" />
      </div>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const dashboard = useDashboardHome()
const contributions = dashboard.contributions
const toast = useToast()
const loading = ref(true)
const activeProvidersCount = ref(0)
const totalProvidersCount = ref(0)
const totalModelsCount = ref(0)
const protocolCounts = ref<Record<string, number>>({})
const modelsByProvider = ref<Record<string, number>>({})

const providerDisplayNames = ref<Record<string, string>>({})

function getProviderDisplayName(providerName: string): string {
  return providerDisplayNames.value[providerName] || providerName
}

async function loadModels() {
  const data = await $fetch('/api/hub/models')
  const models = (data as any).models || []
  totalModelsCount.value = models.length
  const mByProvider: Record<string, number> = {}
  models.forEach((m: any) => {
    if (m.provider) {
      mByProvider[m.provider] = (mByProvider[m.provider] || 0) + 1
    }
  })
  modelsByProvider.value = mByProvider
}

const refreshing = ref(false)
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

onMounted(async () => {
  try {
    const [providersData] = await Promise.all([
      $fetch('/api/hub/providers'),
      dashboard.load()
    ])

    const providers = (providersData as any).providers || []
    totalProvidersCount.value = providers.length
    activeProvidersCount.value = providers.filter((p: any) => p.enabled).length

    const nameMap: Record<string, string> = {}
    providers.forEach((p: any) => { nameMap[p.name] = p.display_name || p.name })
    providerDisplayNames.value = nameMap

    dashboard.commit()

    // Calculate protocols
    const pCounts: Record<string, number> = {}
    providers.forEach((p: any) => {
      if (p.enabled && p.protocol) {
        pCounts[p.protocol] = (pCounts[p.protocol] || 0) + 1
      }
    })
    protocolCounts.value = pCounts

    await loadModels()
    dashboard.afterLoad() // non-blocking
  } catch (error: any) {
    if (error?.statusCode === 401) return navigateTo('/login')
    console.error('Failed to load dashboard metrics:', error)
  } finally {
    loading.value = false
  }
})
</script>
