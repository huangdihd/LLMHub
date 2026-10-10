<template>
  <div v-if="record.monthly_limit > 0" class="mt-4 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
    <div
      class="h-full rounded-full transition-all"
      :class="record.tokens_used >= record.monthly_limit ? 'bg-red-500' : 'bg-primary-500'"
      :style="{ width: Math.min(100, record.tokens_used / record.monthly_limit * 100) + '%' }"
    />
  </div>
</template>

<script setup lang="ts">
import type { QuotaRecord } from '../dashboard-api-key'
defineProps<{ record: QuotaRecord }>()
</script>
