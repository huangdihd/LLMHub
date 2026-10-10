<template>
          <div v-if="modelQuotaEntries(record).length > 0">
            <span class="text-gray-500 dark:text-gray-400">Model Quotas:</span>
            <div class="flex flex-wrap gap-1 mt-1">
              <UBadge v-for="mq in modelQuotaEntries(record)" :key="mq.id" color="pink" variant="soft">
                {{ mq.id }}: {{ mq.limit.toLocaleString() }}
              </UBadge>
            </div>
          </div>

          <div v-if="providerQuotaEntries(record).length > 0">
            <span class="text-gray-500 dark:text-gray-400">Provider Quotas:</span>
            <div class="flex flex-wrap gap-1 mt-1">
              <UBadge v-for="pq in providerQuotaEntries(record)" :key="pq.id" color="yellow" variant="soft">
                {{ pq.id }}: {{ pq.limit.toLocaleString() }}
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
