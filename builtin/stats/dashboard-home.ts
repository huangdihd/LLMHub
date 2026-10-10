import { ref } from 'vue'
import { navigateTo } from '#imports'
import metric from './components/DashboardCallMetric.vue'
import usage from './components/DashboardKeyUsage.vue'
import type { DashboardHomeContribution } from '../../shared/dashboard/home'

interface DashboardKeyUsage {
  id: string
  name: string
  monthly_limit: number
  tokens_used: number
  call_count: number
  allowed_providers: string[]
  allowed_models: string[]
}

export default {
  order: 0,
  metric,
  usage,
  create() {
    const totalApiCalls = ref(0)
    const apiKeys = ref<DashboardKeyUsage[]>([])
    const refreshingKeys = ref(false)
    const keysLoaded = ref(false)
    let pendingTotalCalls = 0

    async function loadKeyStats() {
      refreshingKeys.value = true
      try {
        const data = await $fetch<{ keys?: DashboardKeyUsage[] }>('/api/hub/keys')
        apiKeys.value = data.keys || []
      } catch (error: unknown) {
        if ((error as { statusCode?: number })?.statusCode === 401) {
          return navigateTo('/login')
        }
        apiKeys.value = []
      } finally {
        refreshingKeys.value = false
        keysLoaded.value = true
      }
    }

    return {
      metricProps: () => ({ totalApiCalls: totalApiCalls.value }),
      usageProps: () => ({ apiKeys: apiKeys.value, refreshingKeys: refreshingKeys.value, keysLoaded: keysLoaded.value, loadKeyStats }),
      async load() {
        const data = await $fetch<{ totalCalls?: number }>('/api/hub/stats').catch(() => ({ totalCalls: 0 }))
        pendingTotalCalls = data.totalCalls || 0
      },
      commit() { totalApiCalls.value = pendingTotalCalls },
      afterLoad() { void loadKeyStats() }
    }
  }
} satisfies DashboardHomeContribution
