<template>
              <div class="flex items-center gap-1 sm:ml-2" title="Token billing ratios">
                <span class="text-xs text-gray-500">In</span>
                <UInput v-model="model.tokenRatios.input" type="number" min="0" max="10000" step="1" size="xs" class="w-16" />
                <span class="text-xs text-gray-500">Out</span>
                <UInput v-model="model.tokenRatios.output" type="number" min="0" max="10000" step="1" size="xs" class="w-16" />
                <span class="text-xs text-gray-500">Cached</span>
                <UInput v-model="model.tokenRatios.cached" type="number" min="0" max="10000" step="1" size="xs" class="w-16" />
                <span class="text-xs text-gray-500">%</span>
                <UButton
                  color="primary"
                  variant="ghost"
                  size="xs"
                  icon="i-heroicons-check"
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
