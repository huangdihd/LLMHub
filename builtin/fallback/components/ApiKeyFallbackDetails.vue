<template>
          <div v-if="record.fallback_strategy?.enabled && record.fallback_strategy?.priority?.length > 0">
            <span class="text-gray-500 dark:text-gray-400">Fallback:</span>
            <div class="flex flex-wrap gap-1 mt-1 items-center">
              <span v-for="(m, i) in record.fallback_strategy.priority" :key="m" class="flex items-center gap-0">
                <UBadge color="orange" variant="soft">{{ m }}</UBadge>
                <span v-if="Number(i) < record.fallback_strategy.priority.length - 1" class="mx-0.5 text-gray-400">&rarr;</span>
              </span>
            </div>
          </div>
</template>

<script setup lang="ts">
import type { FallbackRecord } from '../dashboard-api-key'
defineProps<{ record: FallbackRecord }>()
</script>
