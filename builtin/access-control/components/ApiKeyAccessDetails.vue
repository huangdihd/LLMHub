<template>
  <div class="flex flex-col gap-1.5 sm:flex-row sm:gap-4">
    <span class="w-32 flex-shrink-0 text-gray-500 dark:text-gray-400">Access</span>
    <div v-if="record.allowed_providers.length > 0 || record.allowed_models.length > 0" class="flex flex-wrap gap-1.5">
      <UBadge v-for="p in record.allowed_providers" :key="p" color="blue" variant="soft" size="xs">{{ p }}</UBadge>
      <UBadge v-for="m in record.allowed_models" :key="m" color="purple" variant="soft" size="xs"><span class="font-mono">{{ m }}</span></UBadge>
    </div>
    <span v-else class="text-gray-700 dark:text-gray-300">All providers and models</span>
  </div>
</template>

<script setup lang="ts">
import type { AccessRecord } from '../dashboard-api-key'
defineProps<{ record: AccessRecord }>()
</script>
