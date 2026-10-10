<template>
  <div v-if="plugins.length || runtime.error.value" :class="compact ? 'flex items-center gap-3' : 'space-y-4'">
    <UAlert v-if="runtime.error.value || loadError" color="red" title="Plugin fields could not be loaded. Reopen the editor to retry." />
    <PageLoading v-else-if="loading" />
    <fieldset v-for="plugin in plugins" v-else :key="plugin.id" :disabled="saving" :title="compact ? plugin.name : undefined" :class="compact ? 'flex items-center gap-1.5' : 'space-y-3'">
      <legend :class="compact ? 'sr-only' : 'text-sm font-medium text-gray-900 dark:text-white'">{{ plugin.name }}</legend>
      <PluginSchemaForm :ref="instance => setForm(plugin.id, instance)" v-model="values[plugin.id]" :fields="plugin.contributes[location] || []" :editing="!!recordId" :compact="compact" />
    </fieldset>
  </div>
</template>

<script setup lang="ts">
import { runtimeContributionValuesURL, useRuntimePluginContributions } from '~/composables/useRuntimePluginContributions'
import type { RuntimeContributionLocation } from '~/composables/useRuntimePluginContributions'

const props = defineProps<{ location: RuntimeContributionLocation; recordId?: string; compact?: boolean }>()
const runtime = useRuntimePluginContributions()
const plugins = computed(() => runtime.plugins.value.filter(plugin => plugin.contributes[props.location]?.length))
const values = ref<Record<string, Record<string, unknown>>>({})
const forms = new Map<string, { validate: () => boolean }>()
const loading = ref(true)
const loadError = ref(false)
const saving = ref(false)
let generation = 0

function setForm(id: string, instance: unknown) {
  if (instance) forms.set(id, instance as { validate: () => boolean })
  else forms.delete(id)
}

watch([plugins, () => props.recordId, () => props.location], async () => {
  const current = ++generation
  loading.value = true
  loadError.value = false
  try {
    const entries = await Promise.all(plugins.value.map(async plugin => {
      const stored = props.recordId
        ? await $fetch<Record<string, unknown>>(runtimeContributionValuesURL(plugin.id, props.location, props.recordId))
        : {}
      // Never turn masked or accidentally returned secrets into replacement credentials.
      for (const field of plugin.contributes[props.location] || []) {
        if (field.type === 'secret') delete stored[field.key]
      }
      return [plugin.id, stored] as const
    }))
    if (current === generation) values.value = Object.fromEntries(entries)
  } catch {
    if (current === generation) loadError.value = true
  } finally {
    if (current === generation) loading.value = false
  }
}, { immediate: true })

function validate() {
  if (runtime.pending.value || runtime.error.value || loading.value || loadError.value) return false
  return plugins.value.map(plugin => forms.get(plugin.id)?.validate() ?? false).every(Boolean)
}

async function save(recordId: string) {
  saving.value = true
  try {
    // Schema validation emits defaults and omitted secrets; let Vue propagate those models.
    await nextTick()
    // Sequential writes keep failures attributable; already saved fields are safe to retry.
    for (const plugin of plugins.value) {
      try {
        await $fetch(runtimeContributionValuesURL(plugin.id, props.location, recordId), {
          method: 'PUT', body: values.value[plugin.id]
        })
      } catch {
        throw new Error(`The record was saved, but ${plugin.name} fields were not. Retry Save to finish.`)
      }
    }
  } finally {
    saving.value = false
  }
}

defineExpose({ validate, save })
</script>
