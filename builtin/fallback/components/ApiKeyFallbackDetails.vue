<template>
  <div v-if="record.fallback_strategy?.enabled && record.fallback_strategy?.priority?.length > 0" class="flex flex-col gap-1.5 sm:flex-row sm:gap-4">
    <span class="w-32 flex-shrink-0 text-gray-500 dark:text-gray-400">Fallback order</span>
    <div class="flex flex-wrap items-center gap-1.5">
      <template v-for="(m, i) in record.fallback_strategy.priority" :key="m">
        <UIcon v-if="Number(i) > 0" name="i-heroicons-chevron-right-20-solid" class="w-4 h-4 text-gray-400" />
        <UBadge color="gray" variant="soft" size="xs"><span class="font-mono">{{ m }}</span></UBadge>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { FallbackRecord } from '../dashboard-api-key'
defineProps<{ record: FallbackRecord }>()
</script>
