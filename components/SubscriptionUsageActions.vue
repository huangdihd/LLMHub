<template>
            <UButton
              color="gray"
              variant="ghost"
              :icon="usageState(provider.name).expanded ? 'i-heroicons-chevron-up' : 'i-heroicons-chevron-down'"
              :aria-expanded="usageState(provider.name).expanded"
              :aria-controls="`subscription-usage-${provider.name}`"
              @click="toggleUsageDetails(provider.name)"
            >{{ usageState(provider.name).expanded ? 'Hide details' : 'Details' }}</UButton>
</template>
<script setup lang="ts">
import { toRefs } from 'vue'
import type { DashboardProviderRecord } from '~/shared/dashboard/providers'
import type { SubscriptionUsageDashboard } from '~/composables/useSubscriptionUsage'
const props = defineProps<{ state: SubscriptionUsageDashboard; provider: DashboardProviderRecord }>()
const { usageState, toggleUsageDetails } = toRefs(props.state)
</script>
