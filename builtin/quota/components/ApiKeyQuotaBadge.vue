<template>
  <UBadge v-if="Number(record.monthly_limit) > 0" :color="Number(record.tokens_used) >= Number(record.monthly_limit) ? 'red' : 'green'" variant="subtle" size="sm">
    {{ record.tokens_used.toLocaleString() }} / {{ record.monthly_limit.toLocaleString() }} tokens
  </UBadge>
  <UBadge v-else color="gray" variant="subtle" size="sm">No limit</UBadge>
</template>

<script setup lang="ts">
import type { QuotaRecord } from '../dashboard-api-key'
defineProps<{ record: QuotaRecord }>()
</script>
