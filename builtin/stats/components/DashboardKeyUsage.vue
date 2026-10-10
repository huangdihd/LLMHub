<template>
        <UCard>
          <template #header>
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-medium text-gray-900 dark:text-white flex items-center gap-2">
                <UIcon name="i-heroicons-key" class="w-5 h-5 text-primary" />
                API Key Usage
              </h3>
              <UButton color="gray" variant="ghost" size="xs" icon="i-heroicons-arrow-path" :loading="refreshingKeys" @click="loadKeyStats" />
            </div>
          </template>

          <div v-if="apiKeys.length === 0" class="text-center py-6 text-sm text-gray-500">
            <UIcon name="i-heroicons-key" class="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
            <p>No API keys created yet.</p>
            <p class="text-xs mt-1">Create keys from the API Keys page to see usage here.</p>
          </div>

          <div v-else class="space-y-3">
            <div v-for="key in apiKeys" :key="key.id" class="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-800">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-sm font-medium text-gray-900 dark:text-white">{{ key.name }}</span>
                  <UBadge v-if="key.monthly_limit > 0" :color="key.tokens_used >= key.monthly_limit ? 'red' : 'green'" variant="soft" size="xs">
                    {{ Math.round(key.tokens_used / key.monthly_limit * 100) }}%
                  </UBadge>
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400">
                  {{ key.tokens_used.toLocaleString() }} / {{ key.monthly_limit > 0 ? key.monthly_limit.toLocaleString() : '∞' }} tokens · {{ key.call_count }} calls
                </div>
                <div v-if="key.allowed_providers.length > 0 || key.allowed_models.length > 0" class="flex flex-wrap gap-1 mt-1">
                  <UBadge v-for="p in key.allowed_providers" :key="p" color="blue" variant="soft" size="xs">{{ p }}</UBadge>
                  <UBadge v-for="m in key.allowed_models" :key="m" color="purple" variant="soft" size="xs">{{ m }}</UBadge>
                </div>
              </div>
              <!-- mini progress bar -->
              <div v-if="key.monthly_limit > 0" class="ml-4 w-16">
                <div class="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div class="h-full rounded-full transition-all" :class="key.tokens_used >= key.monthly_limit ? 'bg-red-500' : 'bg-primary'" :style="{ width: Math.min(100, key.tokens_used / key.monthly_limit * 100) + '%' }" />
                </div>
              </div>
            </div>
          </div>
        </UCard>
</template>

<script setup lang="ts">
defineProps<{ apiKeys: any[]; refreshingKeys: boolean; loadKeyStats: () => Promise<void> }>()
</script>
