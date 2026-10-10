<template>
          <UDivider />

          <div class="flex items-center justify-between">
            <h4 class="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-2">
              <UIcon name="i-heroicons-bolt" class="w-4 h-4 text-primary" />
              API Rate Limiting
            </h4>
            <UToggle v-model="config.rate_limit_enabled" />
          </div>

          <UFormGroup label="Max Requests per Minute" help="Maximum API calls per IP per 60-second window. 0 = unlimited.">
            <UInput v-model.number="config.rate_limit_max_rpm" type="number" min="0" max="10000" :disabled="!config.rate_limit_enabled" />
          </UFormGroup>

</template>

<script setup lang="ts">
defineProps<{ config: { rate_limit_enabled: boolean; rate_limit_max_rpm: number } }>()
</script>
