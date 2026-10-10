<template>
        <div
          v-if="usageState(provider.name).expanded"
          :id="`subscription-usage-${provider.name}`"
          class="mt-5 border-t border-gray-200 dark:border-gray-700 pt-4"
        >
          <div class="flex items-center justify-between gap-3">
            <UBadge
              :color="usageState(provider.name).data?.plan ? 'primary' : 'gray'"
              variant="subtle"
              size="sm"
            >
              {{ usageState(provider.name).data?.plan ? titleCase(usageState(provider.name).data!.plan!) : 'Plan unavailable' }}
            </UBadge>
            <UButton
              color="gray"
              variant="ghost"
              size="xs"
              icon="i-heroicons-arrow-path"
              :loading="usageState(provider.name).loading"
              :disabled="usageState(provider.name).loading"
              @click="fetchSubscriptionUsage(provider.name, true)"
            >Refresh</UButton>
          </div>

          <div v-if="usageState(provider.name).loading && !usageState(provider.name).data" class="flex items-center gap-2 py-5 text-sm text-gray-500 dark:text-gray-400">
            <UIcon name="i-heroicons-arrow-path" class="h-4 w-4 animate-spin" />
            Loading quota details…
          </div>
          <p v-else-if="usageState(provider.name).error" class="py-4 text-sm text-red-600 dark:text-red-400" role="alert">
            {{ usageState(provider.name).error }}
          </p>
          <template v-else-if="usageState(provider.name).data">
            <div v-if="usageState(provider.name).data!.windows.length" class="mt-4 space-y-4">
              <div v-for="window in usageState(provider.name).data!.windows" :key="window.id">
                <div class="flex items-baseline justify-between gap-3 text-sm">
                  <span class="font-medium text-gray-800 dark:text-gray-200">{{ window.label }}</span>
                  <span class="tabular-nums text-gray-500 dark:text-gray-400">{{ formatPercent(window.used_percent) }} used</span>
                </div>
                <div
                  class="mt-1.5 h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
                  role="progressbar"
                  :aria-label="`${window.label}: ${formatPercent(window.used_percent)} used`"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  :aria-valuenow="clampPercent(window.used_percent)"
                >
                  <div class="h-full rounded-full bg-primary-500" :style="{ width: `${clampPercent(window.used_percent)}%` }" />
                </div>
                <div v-if="window.reset_at || window.detail" class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                  <span v-if="window.reset_at">Resets {{ formatResetTime(window.reset_at) }}</span>
                  <span v-if="window.detail">{{ window.detail }}</span>
                </div>
              </div>
            </div>
            <p v-else class="mt-4 text-sm text-gray-500 dark:text-gray-400">Quota details unavailable</p>

            <div v-if="usageState(provider.name).data!.credits" class="mt-4 rounded-md bg-gray-50 px-3 py-2 text-sm dark:bg-gray-800/60">
              <span class="font-medium text-gray-800 dark:text-gray-200">Credits:</span>
              <span class="ml-1 text-gray-600 dark:text-gray-300">
                {{ formatCredits(usageState(provider.name).data!.credits!) }}
              </span>
              <p v-if="usageState(provider.name).data!.credits!.detail" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {{ usageState(provider.name).data!.credits!.detail }}
              </p>
            </div>

          </template>
        </div>
</template>
<script setup lang="ts">
import { toRefs } from 'vue'
import type { DashboardProviderContext, DashboardProviderRecord } from '~/shared/dashboard/providers'
import type { DashboardState } from '../dashboard-state'
const props = defineProps<{ state: DashboardState; provider: DashboardProviderRecord }>()
const { usageState, titleCase, fetchSubscriptionUsage, formatPercent, clampPercent, formatResetTime, formatCredits } = toRefs(props.state)
</script>
