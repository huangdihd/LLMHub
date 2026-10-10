<template>
  <p v-if="error" class="mt-2 text-sm text-red-500">Plugin fields could not be loaded.</p>
  <p v-else-if="plugins.length" class="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-500 dark:text-gray-400 empty:hidden">
    <template v-for="plugin in plugins" :key="plugin.id">
      <template v-for="field in plugin.contributes.apiKeys?.filter(field => field.showInList && field.type !== 'secret')" :key="field.key">
        <span v-if="shown(plugin.id, field) !== ''" :title="plugin.name">{{ field.label || field.key }} <span class="text-gray-900 dark:text-white">{{ shown(plugin.id, field) }}</span></span>
      </template>
    </template>
  </p>
</template>

<script setup lang="ts">
import { runtimeContributionValuesURL, useRuntimePluginContributions } from '~/composables/useRuntimePluginContributions'
const props = defineProps<{ recordId: string; revision: number }>()
const runtime = useRuntimePluginContributions()
const plugins = computed(() => runtime.plugins.value.filter(plugin => plugin.contributes.apiKeys?.some(field => field.showInList && field.type !== 'secret')))
const values = ref<Record<string, Record<string, unknown>>>({})
const error = ref(false)
function shown(pluginId: string, field: { key: string; default?: unknown }) {
  const value = values.value[pluginId]?.[field.key] ?? field.default
  return value === undefined || value === null ? '' : String(value)
}
let generation = 0
watch([plugins, () => props.recordId, () => props.revision], async () => {
  const current = ++generation
  error.value = false
  try {
    const entries = await Promise.all(plugins.value.map(async plugin => [plugin.id,
      await $fetch<Record<string, unknown>>(runtimeContributionValuesURL(plugin.id, 'apiKeys', props.recordId))] as const))
    if (current === generation) values.value = Object.fromEntries(entries)
  } catch { if (current === generation) error.value = true }
}, { immediate: true })
</script>
