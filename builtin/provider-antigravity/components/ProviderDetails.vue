<template>
          <div class="mt-4 flex items-center justify-between gap-4 rounded-lg bg-amber-50 p-3 dark:bg-amber-950/20">
            <div>
              <p class="text-sm font-medium text-gray-800 dark:text-gray-200">Use Google One AI Credits</p>
              <p class="text-xs text-gray-500 dark:text-gray-400">Paid usage. Only retry once with AI Credits when Google explicitly reports that the free model quota is exhausted. Rate limits do not trigger it.</p>
            </div>
            <UToggle
              :model-value="provider.connection.use_ai_credits_on_quota_exhausted === true"
              :disabled="aiCreditsSaving[provider.name]"
              :aria-label="`Use Google One AI Credits for ${provider.display_name}`"
              @update:model-value="setAiCredits(provider, $event)"
            />
          </div>

</template>
<script setup lang="ts">
import { toRefs } from 'vue'
import type { DashboardProviderContext, DashboardProviderRecord } from '~/shared/dashboard/providers'
import type { DashboardState } from '../dashboard-state'
const props = defineProps<{ state: DashboardState; provider: DashboardProviderRecord }>()
const { aiCreditsSaving, setAiCredits } = toRefs(props.state)
</script>
