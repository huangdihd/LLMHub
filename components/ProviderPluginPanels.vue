<template>
  <details v-for="entry in providerPanels" :key="`${entry.pluginId}:${entry.panel.id}`" class="group mt-5 border-t border-gray-100 dark:border-gray-800 pt-4">
    <summary class="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 [&::-webkit-details-marker]:hidden">
      <UIcon name="i-heroicons-chevron-right-20-solid" class="w-4 h-4 text-gray-400 transition-transform group-open:rotate-90" />{{ entry.panel.title }}
    </summary>
    <div class="mt-4">
      <RuntimePluginPanel :plugin-id="entry.pluginId" :panel="entry.panel" :provider="{ name: provider.name, type: provider.protocol }" />
    </div>
  </details>
</template>

<script setup lang="ts">
import type { DashboardProviderRecord } from '~/shared/dashboard/providers'

const props = defineProps<{ provider: DashboardProviderRecord }>()
const { panels } = useRuntimePluginContributions()
const providerPanels = computed(() => panels.value.filter(entry =>
  entry.panel.location === 'provider' && entry.panel.providerType === props.provider.protocol))
</script>
