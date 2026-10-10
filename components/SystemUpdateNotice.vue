<template>
  <NuxtLink v-if="system?.check.status === 'available'" to="/updates" class="mb-6 flex items-center justify-between gap-3 rounded-lg bg-blue-50 dark:bg-blue-400/10 ring-1 ring-inset ring-blue-500/25 px-4 py-3 text-sm hover:ring-blue-500/50 transition">
    <span class="flex items-center gap-2 text-blue-800 dark:text-blue-200">
      <UIcon name="i-heroicons-arrow-up-circle" class="w-5 h-5 flex-shrink-0" />
      <span><span class="font-medium">LLMHub {{ system.check.latestVersion }} is available.</span> You are on {{ system.version }}.</span>
    </span>
    <span class="flex items-center gap-1 font-medium text-blue-700 dark:text-blue-300 flex-shrink-0">{{ system.canUpdate ? 'Update' : 'How to update' }}<UIcon name="i-heroicons-arrow-right-20-solid" class="w-4 h-4" /></span>
  </NuxtLink>
</template>

<script setup lang="ts">
import type { SystemUpdateOverview } from '~/shared/types/system-update'

const { data: system } = await useFetch<SystemUpdateOverview>('/api/hub/system', { server: false, lazy: true })
</script>
