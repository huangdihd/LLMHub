<template>
  <UContainer class="py-8 max-w-5xl">
    <PageHeader :title="selected?.panel.title || 'Plugin panel'" />
    <PageLoading v-if="runtime.pending.value" />
    <UAlert v-else-if="runtime.error.value" color="red" title="Plugin panels could not be loaded.">
      <template #actions><UButton @click="runtime.refresh()">Retry</UButton></template>
    </UAlert>
    <RuntimePluginPanel v-else-if="selected" :plugin-id="selected.pluginId" :panel="selected.panel" />
    <EmptyState v-else icon="i-heroicons-puzzle-piece" title="Panel unavailable" description="The plugin may be disabled, or this panel no longer exists." />
  </UContainer>
</template>

<script setup lang="ts">
import { useRuntimePluginContributions } from '~/composables/useRuntimePluginContributions'
const route = useRoute()
const runtime = useRuntimePluginContributions()
const selected = computed(() => runtime.panels.value.find(item =>
  item.pluginId === route.params.pluginId && item.panel.id === route.params.panelId && item.panel.location === 'page'))
</script>
