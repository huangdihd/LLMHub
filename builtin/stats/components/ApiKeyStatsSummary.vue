<template>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4 text-sm mb-4">
          <div>
            <span class="text-gray-500 dark:text-gray-400">Calls:</span>
            <span class="ml-2 font-medium text-gray-900 dark:text-white">{{ record.call_count }}</span>
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">Tokens used:</span>
            <span class="ml-2 font-medium text-gray-900 dark:text-white">{{ record.tokens_used.toLocaleString() }}</span>
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">Created:</span>
            <span class="ml-2 font-medium text-gray-900 dark:text-white">{{ new Date(record.created_at).toLocaleDateString() }}</span>
          </div>
        </div>
</template>

<script setup lang="ts">
import type { StatsRecord } from '../dashboard-api-key'
defineProps<{ record: StatsRecord }>()
</script>
