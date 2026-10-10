<template>
  <div class="border-t border-gray-100 dark:border-gray-800 pt-5">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h4 class="text-sm font-medium text-gray-900 dark:text-white">API rate limit</h4>
        <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">Cap how many API requests one IP address can make.</p>
      </div>
      <UToggle v-model="config.rate_limit_enabled" aria-label="API rate limit" />
    </div>
    <UFormGroup class="mt-4 sm:max-w-xs" label="Requests per minute" help="Per IP address. 0 means no limit.">
      <UInput v-model.number="config.rate_limit_max_rpm" type="number" min="0" max="10000" :disabled="!config.rate_limit_enabled" />
    </UFormGroup>
  </div>
</template>

<script setup lang="ts">
defineProps<{ config: { rate_limit_enabled: boolean; rate_limit_max_rpm: number } }>()
</script>
