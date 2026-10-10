<template>
  <p class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
    <span><span class="tabular-nums text-gray-900 dark:text-white">{{ record.call_count.toLocaleString() }}</span> calls</span>
    <span><span class="tabular-nums text-gray-900 dark:text-white">{{ record.tokens_used.toLocaleString() }}</span> tokens used</span>
    <span>Created {{ new Date(record.created_at).toLocaleDateString() }}</span>
  </p>
</template>

<script setup lang="ts">
import type { StatsRecord } from '../dashboard-api-key'
defineProps<{ record: StatsRecord }>()
</script>
