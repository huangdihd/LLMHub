<template>
        <div v-if="record.monthly_limit > 0" class="mb-3">
          <div class="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              class="h-full rounded-full transition-all"
              :class="record.tokens_used >= record.monthly_limit ? 'bg-red-500' : 'bg-primary'"
              :style="{ width: Math.min(100, record.tokens_used / record.monthly_limit * 100) + '%' }"
            />
          </div>
        </div>
</template>

<script setup lang="ts">
import type { QuotaRecord } from '../dashboard-api-key'
defineProps<{ record: QuotaRecord }>()
</script>
