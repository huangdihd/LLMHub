<template>
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
</template>

<script setup lang="ts">
defineProps<{ loading: boolean; totalApiCalls: number }>()
</script>
