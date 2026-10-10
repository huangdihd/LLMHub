<template>
              <UBadge
                :color="provider.connection.authenticated ? 'green' : 'red'"
                variant="subtle"
                size="sm"
              >
                {{ provider.connection.authenticated ? 'Claude connected' : 'Reconnect required' }}
              </UBadge>
</template>
<script setup lang="ts">
import type { DashboardProviderRecord } from '~/shared/dashboard/providers'
defineProps<{ provider: DashboardProviderRecord }>()
</script>
