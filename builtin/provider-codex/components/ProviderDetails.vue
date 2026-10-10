<template>
          <div class="mt-4 flex items-center justify-between gap-4 rounded-lg bg-gray-50 p-3 dark:bg-gray-800/50">
            <div>
              <p class="text-sm font-medium text-gray-800 dark:text-gray-200">Automatically use a banked reset</p>
              <p class="text-xs text-gray-500 dark:text-gray-400">When Codex rejects a request because its quota is exhausted, use one reset and retry that request once.</p>
            </div>
            <UToggle
              :model-value="provider.connection.auto_reset_on_quota_exhausted === true"
              :disabled="autoResetSaving[provider.name]"
              :aria-label="`Automatically use a banked reset for ${provider.display_name}`"
              @update:model-value="setAutoReset(provider, $event)"
            />
          </div>

</template>
<script setup lang="ts">
import { toRefs } from 'vue'
import type { DashboardProviderContext, DashboardProviderRecord } from '~/shared/dashboard/providers'
import type { DashboardState } from '../dashboard-state'
const props = defineProps<{ state: DashboardState; provider: DashboardProviderRecord }>()
const { autoResetSaving, setAutoReset } = toRefs(props.state)
</script>
