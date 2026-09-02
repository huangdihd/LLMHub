<template>
  <UContainer class="py-8 max-w-4xl">
    <div class="mb-6">
      <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Thinking Policy</h2>
      <p class="mt-1 text-gray-500 dark:text-gray-400">Map thinking budgets and effort levels across Claude, OpenAI/Codex, and Gemini.</p>
    </div>

    <div v-if="loading" class="flex justify-center py-12"><UIcon name="i-heroicons-arrow-path" class="w-8 h-8 animate-spin" /></div>
    <template v-else>
      <UCard class="mb-6">
        <template #header><div class="flex items-center justify-between"><h3 class="text-lg font-medium">Global policy</h3><UToggle v-model="settings.enabled" /></div></template>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormGroup label="Respect client request" help="When on, requests without thinking parameters keep the upstream model default; explicit client values are never overridden."><UToggle v-model="settings.respectClient" /></UFormGroup>
          <UFormGroup label="Return reasoning summaries"><UToggle v-model="settings.includeSummary" /></UFormGroup>
          <UFormGroup label="Default effort" help="Only applied when Respect client request is disabled"><USelect v-model="settings.defaultEffort" :options="efforts" /></UFormGroup>
        </div>
      </UCard>

      <UCard class="mb-6">
        <template #header><h3 class="text-lg font-medium">Effort to token budget mapping</h3></template>
        <p class="mb-4 text-sm text-gray-500 dark:text-gray-400">Incoming budgets map to the highest configured effort not exceeding that budget. Values must be increasing.</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormGroup v-for="effort in effortValues" :key="effort" :label="title(effort)">
            <UInput v-model.number="settings.budgetMap[effort]" type="number" min="0" max="1000000" />
          </UFormGroup>
        </div>
      </UCard>

      <UCard class="mb-6">
        <template #header><h3 class="text-lg font-medium">Conversion preview</h3></template>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormGroup label="Requested effort"><USelect v-model="previewEffort" :options="efforts" /></UFormGroup>
          <UFormGroup label="Resulting budget"><UInput :model-value="String(settings.budgetMap[previewEffort])" disabled /></UFormGroup>
        </div>
      </UCard>

      <UAlert class="mb-6" color="yellow" variant="soft" title="Opaque reasoning state">
        Claude signatures/redacted thinking and Codex encrypted reasoning are never displayed or editable here. They are only returned to compatible upstream providers.
      </UAlert>
      <div class="flex justify-end"><UButton :loading="saving" @click="save">Save configuration</UButton></div>
    </template>
  </UContainer>
</template>

<script setup lang="ts">
type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
const effortValues: Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
const efforts = effortValues.map(value => ({ value, label: value === 'xhigh' ? 'XHigh' : value[0].toUpperCase() + value.slice(1) }))
const toast = useToast()
const loading = ref(true)
const saving = ref(false)
const previewEffort = ref<Effort>('medium')
const settings = reactive<any>({ enabled: true, respectClient: true, defaultEffort: 'medium', includeSummary: true, budgetMap: { none: 0, minimal: 1024, low: 4096, medium: 8192, high: 16384, xhigh: 32768 } })
const title = (value: string) => value === 'xhigh' ? 'XHigh' : value[0].toUpperCase() + value.slice(1)

async function load() {
  try { Object.assign(settings, await ($fetch as any)('/api/hub/thinking')) }
  catch (error: any) { if (error?.statusCode === 401) { window.location.assign('/login'); return }; toast.add({ title: 'Error', description: 'Failed to load thinking policy', color: 'red' }) }
  finally { loading.value = false }
}
async function save() {
  saving.value = true
  try {
    await $fetch('/api/hub/thinking' as any, { method: 'PUT', body: settings })
    toast.add({ title: 'Saved', description: 'Thinking policy updated', color: 'green' })
  } catch (error: any) { toast.add({ title: 'Error', description: error?.data?.message || 'Invalid thinking configuration', color: 'red' }) }
  finally { saving.value = false }
}
onMounted(load)
</script>
