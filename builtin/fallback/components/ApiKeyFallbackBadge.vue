<template>
  <UBadge v-if="record.fallback_strategy?.enabled" color="orange" variant="subtle" size="sm">
    Fallback · {{ record.fallback_strategy.name || 'auto' }}
  </UBadge>
</template>

<script setup lang="ts">
import type { FallbackRecord } from '../dashboard-api-key'
defineProps<{ record: FallbackRecord }>()
</script>
