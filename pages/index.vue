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
            <h3 class="text-lg font-medium text-gray-900 dark:text-white">Models Breakdown</h3>
          </template>
          
          <ul v-if="!loading && Object.keys(modelsByProvider).length > 0" class="space-y-3 text-sm">
            <li v-for="(count, provider) in modelsByProvider" :key="provider" class="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded">
              <span class="text-gray-700 dark:text-gray-300 capitalize flex items-center gap-2">
                <UIcon name="i-heroicons-server" class="w-4 h-4 text-gray-400" />
                {{ provider }}
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
            <h3 class="text-lg font-medium text-gray-900 dark:text-white">Supported Endpoints</h3>
          </template>
          
          <ul class="space-y-3 text-sm">
            <li class="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded">
              <span class="text-gray-700 dark:text-gray-300">Chat Completions</span>
              <UBadge color="gray" variant="soft">v1/chat/completions</UBadge>
            </li>
            <li class="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded">
              <span class="text-gray-700 dark:text-gray-300">Completions</span>
              <UBadge color="gray" variant="soft">v1/completions</UBadge>
            </li>
            <li class="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded">
              <span class="text-gray-700 dark:text-gray-300">Claude Messages</span>
              <UBadge color="gray" variant="soft">v1/messages</UBadge>
            </li>
            <li class="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded">
              <span class="text-gray-700 dark:text-gray-300">OpenAI Responses</span>
              <UBadge color="gray" variant="soft">v1/responses</UBadge>
            </li>
          </ul>
        </UCard>
      </div>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const loading = ref(true)
const activeProvidersCount = ref(0)
const totalProvidersCount = ref(0)
const totalModelsCount = ref(0)
const totalApiCalls = ref(0)
const protocolCounts = ref<Record<string, number>>({})
const modelsByProvider = ref<Record<string, number>>({})

onMounted(async () => {
  try {
    const [providersData, modelsData, statsData] = await Promise.all([
      $fetch('/api/hub/providers'),
      $fetch('/api/hub/models'),
      $fetch('/api/hub/stats').catch(() => ({ totalCalls: 0 }))
    ])
    
    const providers = (providersData as any).providers || []
    totalProvidersCount.value = providers.length
    activeProvidersCount.value = providers.filter((p: any) => p.enabled).length
    
    totalApiCalls.value = (statsData as any).totalCalls || 0
    
    // Calculate protocols
    const pCounts: Record<string, number> = {}
    providers.forEach((p: any) => {
      if (p.enabled && p.protocol) {
        pCounts[p.protocol] = (pCounts[p.protocol] || 0) + 1
      }
    })
    protocolCounts.value = pCounts
    
    // Calculate models
    const models = (modelsData as any).models || []
    totalModelsCount.value = models.length
    
    const mByProvider: Record<string, number> = {}
    models.forEach((m: any) => {
      if (m.provider) {
        mByProvider[m.provider] = (mByProvider[m.provider] || 0) + 1
      }
    })
    modelsByProvider.value = mByProvider
    
  } catch (error) {
    console.error('Failed to load dashboard metrics:', error)
  } finally {
    loading.value = false
  }
})
</script>