<template>
  <UContainer class="py-8 max-w-5xl">
    <PageHeader title="Dashboard" description="Overview of your LLMHub gateway.">
      <UButton to="/providers" icon="i-heroicons-server-stack" color="gray" variant="soft" class="dark:!bg-gray-800 dark:!text-gray-100 dark:hover:!bg-gray-700">Providers</UButton>
      <component v-for="(contribution, index) in contributions.filter(item => item.action)" :is="contribution.action" :key="index" />
    </PageHeader>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <component v-for="(contribution, index) in contributions.filter(item => item.metric)" :is="contribution.metric" :key="index" :loading="loading" v-bind="contribution.metricProps()" />
      <StatCard icon="i-heroicons-server-stack" tone="blue" label="Providers" :value="activeProvidersCount" :hint="totalProvidersCount > activeProvidersCount ? `of ${totalProvidersCount} enabled` : undefined" :loading="loading" />
      <StatCard icon="i-heroicons-cpu-chip" tone="green" label="Models" :value="totalModelsCount" :loading="loading" />
      <StatCard icon="i-heroicons-arrows-right-left" tone="purple" label="Provider types" :value="Object.keys(protocolCounts).length" :loading="loading" />
      <StatCard v-for="metric in runtimeMetrics" :key="`${metric.pluginId}:${metric.key}`" :icon="metric.icon || 'i-heroicons-puzzle-piece'" :label="metric.label" :value="metric.error ? 'Unavailable' : metric.value ?? '—'" :hint="metric.error" />
    </div>

    <UAlert v-if="runtime.error.value || metricsError" color="amber" title="Some plugin dashboard contributions could not be loaded." class="mb-6" />

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
      <div class="lg:col-span-2 space-y-6">
        <component v-for="(contribution, index) in contributions.filter(item => item.usage)" :is="contribution.usage" :key="index" v-bind="contribution.usageProps()" />

        <UCard v-for="item in homePanels" :key="`${item.pluginId}:${item.panel.id}`" :ui="{ body: { padding: '' } }">
          <template #header><h3 class="font-medium text-gray-900 dark:text-white">{{ item.panel.title }}</h3></template>
          <RuntimePluginPanel :plugin-id="item.pluginId" :panel="item.panel" />
        </UCard>

        <UCard :ui="{ body: { padding: '' } }">
          <template #header>
            <div class="flex items-center justify-between">
              <h3 class="font-medium text-gray-900 dark:text-white">Models by provider</h3>
              <div class="flex items-center gap-1">
                <UButton color="gray" variant="ghost" size="xs" icon="i-heroicons-arrow-path" aria-label="Refresh models" :loading="refreshing" @click="refreshModels" />
                <UButton color="gray" variant="ghost" size="xs" to="/models" trailing-icon="i-heroicons-arrow-right-20-solid">All models</UButton>
              </div>
            </div>
          </template>
          <div v-if="loading" class="flex justify-center py-8">
            <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 animate-spin text-gray-400" />
          </div>
          <ul v-else-if="Object.keys(modelsByProvider).length > 0" class="divide-y divide-gray-100 dark:divide-gray-800">
            <li v-for="(count, provider) in modelsByProvider" :key="provider" class="flex items-center justify-between gap-4 px-4 py-3 sm:px-6">
              <span class="text-sm text-gray-900 dark:text-white truncate">{{ getProviderDisplayName(provider) }}</span>
              <span class="text-sm tabular-nums text-gray-500 dark:text-gray-400 flex-shrink-0">{{ count }} model{{ count !== 1 ? 's' : '' }}</span>
            </li>
          </ul>
          <EmptyState v-else compact icon="i-heroicons-cpu-chip" title="No models found" description="Connect a provider to see its models here." />
        </UCard>
      </div>

      <UCard v-if="contributions.some(item => item.endpoint)" :ui="{ body: { padding: '' } }">
        <template #header>
          <h3 class="font-medium text-gray-900 dark:text-white">Endpoints</h3>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Point your client's base URL here.</p>
        </template>
        <div class="divide-y divide-gray-100 dark:divide-gray-800">
          <component v-for="(contribution, index) in contributions.filter(item => item.endpoint)" :is="contribution.endpoint" :key="index" />
        </div>
      </UCard>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRuntimePluginContributions } from '~/composables/useRuntimePluginContributions'
import type { RuntimePluginMetric } from '~/composables/useRuntimePluginContributions'

const runtime = useRuntimePluginContributions()
const homePanels = computed(() => runtime.panels.value.filter(item => item.panel.location === 'home'))
const runtimeMetrics = ref<RuntimePluginMetric[]>([])
const metricsError = ref(false)
watch(() => runtime.plugins.value, async (plugins, previous, onCleanup) => {
  let active = true
  onCleanup(() => { active = false })
  runtimeMetrics.value = []
  metricsError.value = false
  if (!plugins.some(plugin => plugin.contributes.metrics?.length)) return
  try {
    const metrics = await $fetch<RuntimePluginMetric[]>('/api/hub/plugin-contributions/metrics')
    if (active) runtimeMetrics.value = metrics
  } catch { if (active) metricsError.value = true }
}, { immediate: true })

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
