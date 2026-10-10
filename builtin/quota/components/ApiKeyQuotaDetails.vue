<template>
  <div v-if="modelQuotaEntries(record).length > 0" class="flex flex-col gap-1.5 sm:flex-row sm:gap-4">
    <span class="w-32 flex-shrink-0 text-gray-500 dark:text-gray-400">Model limits</span>
    <div class="flex flex-wrap gap-1.5">
      <UBadge v-for="mq in modelQuotaEntries(record)" :key="mq.id" color="gray" variant="soft" size="xs">
        <span class="font-mono">{{ mq.id }}</span><span class="ml-1.5 text-gray-500 dark:text-gray-400">{{ mq.limit.toLocaleString() }}</span>
      </UBadge>
    </div>
  </div>

  <div v-if="providerQuotaEntries(record).length > 0" class="flex flex-col gap-1.5 sm:flex-row sm:gap-4">
    <span class="w-32 flex-shrink-0 text-gray-500 dark:text-gray-400">Provider limits</span>
    <div class="flex flex-wrap gap-1.5">
      <UBadge v-for="pq in providerQuotaEntries(record)" :key="pq.id" color="gray" variant="soft" size="xs">
        <span class="font-mono">{{ pq.id }}</span><span class="ml-1.5 text-gray-500 dark:text-gray-400">{{ pq.limit.toLocaleString() }}</span>
      </UBadge>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { QuotaRecord } from '../dashboard-api-key'
defineProps<{ record: QuotaRecord }>()

function modelQuotaEntries(key: QuotaRecord): { id: string; limit: number }[] {
  const quotas: Record<string, number> = key.model_quotas || {}
  return Object.entries(quotas)
    .filter(([, limit]) => limit > 0)
    .map(([id, limit]) => ({ id, limit }))
}

function providerQuotaEntries(key: QuotaRecord): { id: string; limit: number }[] {
  const quotas: Record<string, number> = key.provider_quotas || {}
  return Object.entries(quotas)
    .filter(([, limit]) => limit > 0)
    .map(([id, limit]) => ({ id, limit }))
}


</script>
