<template>
  <UCard :ui="{ body: { padding: '' } }">
    <template #header>
      <div class="flex items-center justify-between">
        <h3 class="font-medium text-gray-900 dark:text-white">API key usage</h3>
        <div class="flex items-center gap-1">
          <UButton color="gray" variant="ghost" size="xs" icon="i-heroicons-arrow-path" aria-label="Refresh usage" :loading="refreshingKeys" @click="loadKeyStats" />
          <UButton color="gray" variant="ghost" size="xs" to="/api-keys" trailing-icon="i-heroicons-arrow-right-20-solid">Manage</UButton>
        </div>
      </div>
    </template>

    <div v-if="!keysLoaded" class="flex justify-center py-8">
      <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 animate-spin text-gray-400" />
    </div>

    <EmptyState v-else-if="apiKeys.length === 0" compact icon="i-heroicons-key" title="No API keys yet" description="Create a key to let clients call the gateway." />

    <ul v-else class="divide-y divide-gray-100 dark:divide-gray-800">
      <li v-for="key in apiKeys" :key="key.id" class="px-4 py-3.5 sm:px-6">
        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <p class="text-sm font-medium text-gray-900 dark:text-white truncate">{{ key.name }}</p>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              {{ key.call_count.toLocaleString() }} calls · {{ key.tokens_used.toLocaleString() }}<template v-if="key.monthly_limit > 0"> / {{ key.monthly_limit.toLocaleString() }}</template> tokens
            </p>
          </div>
          <div v-if="key.monthly_limit > 0" class="flex items-center gap-3 flex-shrink-0">
            <div class="h-1.5 w-24 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div class="h-full rounded-full transition-all" :class="key.tokens_used >= key.monthly_limit ? 'bg-red-500' : 'bg-primary-500'" :style="{ width: Math.min(100, key.tokens_used / key.monthly_limit * 100) + '%' }" />
            </div>
            <span class="w-9 text-right text-xs tabular-nums" :class="key.tokens_used >= key.monthly_limit ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'">{{ Math.round(key.tokens_used / key.monthly_limit * 100) }}%</span>
          </div>
          <span v-else class="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0">No limit</span>
        </div>
        <div v-if="key.allowed_providers.length > 0 || key.allowed_models.length > 0" class="mt-2 flex flex-wrap gap-1">
          <UBadge v-for="p in key.allowed_providers" :key="p" color="blue" variant="soft" size="xs">{{ p }}</UBadge>
          <UBadge v-for="m in key.allowed_models" :key="m" color="purple" variant="soft" size="xs">{{ m }}</UBadge>
        </div>
      </li>
    </ul>
  </UCard>
</template>

<script setup lang="ts">
defineProps<{ apiKeys: any[]; refreshingKeys: boolean; keysLoaded?: boolean; loadKeyStats: () => Promise<void> }>()
</script>
