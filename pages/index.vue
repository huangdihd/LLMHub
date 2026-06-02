<template>
  <UContainer class="py-8 max-w-6xl">
    <div class="flex items-center justify-between mb-8">
      <div>
        <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h2>
        <p class="text-gray-500 dark:text-gray-400 mt-1">Overview of your LLMHub gateway</p>
      </div>
      <div class="flex gap-3">
        <UButton to="/providers" icon="i-heroicons-cog-6-tooth" color="gray" variant="solid">Manage Providers</UButton>
        <UButton to="/chat" icon="i-heroicons-chat-bubble-left-right" color="primary">New Chat</UButton>
      </div>
    </div>

    <!-- Quick Stats -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
      <UCard :ui="{ body: { padding: 'p-6 sm:p-6' } }">
        <div class="flex items-center">
          <div class="p-3 rounded-lg bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400">
            <UIcon name="i-heroicons-chart-bar" class="w-6 h-6" />
          </div>
          <div class="ml-4">
            <p class="text-sm font-medium text-gray-500 dark:text-gray-400">Total API Calls</p>
            <h3 class="text-2xl font-bold text-gray-900 dark:text-white mt-1">
              {{ loading ? '-' : totalApiCalls }}
            </h3>
          </div>
        </div>
      </UCard>
      
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
      <!-- Feature Overview -->
      <div class="lg:col-span-2 space-y-6">
        <UCard>
          <template #header>
            <h3 class="text-lg font-medium text-gray-900 dark:text-white flex items-center gap-2">
              <UIcon name="i-heroicons-sparkles" class="w-5 h-5 text-primary" />
              Gateway Features
            </h3>
          </template>
          
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="flex items-start gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50">
              <UIcon name="i-heroicons-photo" class="w-5 h-5 text-gray-500 dark:text-gray-400 mt-0.5" />
              <div>
                <h4 class="text-sm font-medium text-gray-900 dark:text-white">Multimodal Support</h4>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Process text, images, and other supported media types seamlessly.</p>
              </div>
            </div>
            
            <div class="flex items-start gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50">
              <UIcon name="i-heroicons-wrench-screwdriver" class="w-5 h-5 text-gray-500 dark:text-gray-400 mt-0.5" />
              <div>
                <h4 class="text-sm font-medium text-gray-900 dark:text-white">Tool Calling</h4>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Full support for function calling and structured outputs.</p>
              </div>
            </div>

            <div class="flex items-start gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50">
              <UIcon name="i-heroicons-bolt" class="w-5 h-5 text-gray-500 dark:text-gray-400 mt-0.5" />
              <div>
                <h4 class="text-sm font-medium text-gray-900 dark:text-white">Streaming</h4>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Real-time Server-Sent Events (SSE) streaming responses.</p>
              </div>
            </div>

            <div class="flex items-start gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50">
              <UIcon name="i-heroicons-funnel" class="w-5 h-5 text-gray-500 dark:text-gray-400 mt-0.5" />
              <div>
                <h4 class="text-sm font-medium text-gray-900 dark:text-white">Unified Format</h4>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Standardized provider/model routing syntax.</p>
              </div>
            </div>
          </div>
        </UCard>
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

        <UCard>
          <template #header>
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-medium text-gray-900 dark:text-white flex items-center gap-2">
                <UIcon name="i-heroicons-circle-stack" class="w-5 h-5 text-green-500" />
                OpenAI Base URL
              </h3>
              <UButton
                color="gray"
                variant="ghost"
                size="xs"
                icon="i-heroicons-clipboard-document"
                @click="copyUrl(openaiBaseUrl)"
              />
            </div>
          </template>
          <div class="space-y-2">
            <code class="block text-sm font-mono bg-gray-100 dark:bg-gray-800 px-3 py-2 rounded select-all break-all">
              {{ openaiBaseUrl }}
            </code>
            <div class="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
              <UBadge color="gray" variant="soft">/chat/completions</UBadge>
              <UBadge color="gray" variant="soft">/completions</UBadge>
              <UBadge color="gray" variant="soft">/responses</UBadge>
              <UBadge color="gray" variant="soft">/models</UBadge>
            </div>
          </div>
        </UCard>

        <UCard>
          <template #header>
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-medium text-gray-900 dark:text-white flex items-center gap-2">
                <UIcon name="i-heroicons-circle-stack" class="w-5 h-5 text-orange-500" />
                Claude Base URL
              </h3>
              <UButton
                color="gray"
                variant="ghost"
                size="xs"
                icon="i-heroicons-clipboard-document"
                @click="copyUrl(claudeBaseUrl)"
              />
            </div>
          </template>
          <div class="space-y-2">
            <code class="block text-sm font-mono bg-gray-100 dark:bg-gray-800 px-3 py-2 rounded select-all break-all">
              {{ claudeBaseUrl }}
            </code>
            <div class="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
              <UBadge color="gray" variant="soft">/messages</UBadge>
              <UBadge color="gray" variant="soft">/complete</UBadge>
            </div>
          </div>
        </UCard>
      </div>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const toast = useToast()
const loading = ref(true)
const activeProvidersCount = ref(0)
const totalProvidersCount = ref(0)
const totalModelsCount = ref(0)
const totalApiCalls = ref(0)
const protocolCounts = ref<Record<string, number>>({})
const modelsByProvider = ref<Record<string, number>>({})

const openaiBaseUrl = ref('')
const claudeBaseUrl = ref('')
const providerDisplayNames = ref<Record<string, string>>({})

function getProviderDisplayName(providerName: string): string {
  return providerDisplayNames.value[providerName] || providerName
}

function copyUrl(url: string) {
  navigator.clipboard.writeText(url).then(() => {
    toast.add({ title: 'Copied!', description: url, icon: 'i-heroicons-check-circle', color: 'green', timeout: 2000 })
  }).catch(() => {
    toast.add({ title: 'Copy failed', description: 'Please copy manually', color: 'red', timeout: 2000 })
  })
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
  const origin = window.location.origin
  openaiBaseUrl.value = `${origin}/api/v1/openai`
  claudeBaseUrl.value = `${origin}/api/v1/claude`
  try {
    const [providersData, statsData] = await Promise.all([
      $fetch('/api/hub/providers'),
      $fetch('/api/hub/stats').catch(() => ({ totalCalls: 0 }))
    ])

    const providers = (providersData as any).providers || []
    totalProvidersCount.value = providers.length
    activeProvidersCount.value = providers.filter((p: any) => p.enabled).length

    const nameMap: Record<string, string> = {}
    providers.forEach((p: any) => { nameMap[p.name] = p.display_name || p.name })
    providerDisplayNames.value = nameMap

    totalApiCalls.value = (statsData as any).totalCalls || 0

    // Calculate protocols
    const pCounts: Record<string, number> = {}
    providers.forEach((p: any) => {
      if (p.enabled && p.protocol) {
        pCounts[p.protocol] = (pCounts[p.protocol] || 0) + 1
      }
    })
    protocolCounts.value = pCounts

    await loadModels()
  } catch (error) {
    console.error('Failed to load dashboard metrics:', error)
  } finally {
    loading.value = false
  }
})
</script>