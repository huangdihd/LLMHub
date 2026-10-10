<template>
              <UBadge
                :color="provider.connection.authenticated ? 'green' : 'red'"
                variant="subtle"
                size="sm"
              >
                {{ provider.connection.authenticated ? 'Google connected' : 'Reconnect required' }}
              </UBadge>
</template>
<script setup lang="ts">
import type { DashboardProviderRecord } from '~/shared/dashboard/providers'
defineProps<{ provider: DashboardProviderRecord }>()
</script>
