<template>
  <div class="flex items-center gap-1.5" title="Share of each token type that counts against API key limits">
    <label class="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">In
      <UInput v-model="model.tokenRatios.input" type="number" min="0" max="10000" step="1" size="xs" class="w-14" :ui="{ base: 'text-right tabular-nums' }" />
    </label>
    <label class="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">Out
      <UInput v-model="model.tokenRatios.output" type="number" min="0" max="10000" step="1" size="xs" class="w-14" :ui="{ base: 'text-right tabular-nums' }" />
    </label>
    <label class="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">Cached
      <UInput v-model="model.tokenRatios.cached" type="number" min="0" max="10000" step="1" size="xs" class="w-14" :ui="{ base: 'text-right tabular-nums' }" />
    </label>
    <span class="text-xs text-gray-400 dark:text-gray-500">%</span>
    <UButton
      :color="isRatioDirty(model) ? 'primary' : 'gray'"
      variant="ghost"
      size="xs"
      icon="i-heroicons-check"
      aria-label="Save percentages"
      :loading="savingRatio === model.id"
      :disabled="!isRatioDirty(model)"
      @click="saveRatios(model)"
    />
  </div>
</template>

<script setup lang="ts">
import type { DashboardRecord } from '~/shared/dashboard/sections'

defineProps<{
  model: DashboardRecord
  savingRatio: string
  isRatioDirty: (model: DashboardRecord) => boolean
  saveRatios: (model: DashboardRecord) => Promise<unknown>
}>()
</script>
