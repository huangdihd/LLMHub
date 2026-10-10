<template>
  <UContainer class="py-8 max-w-5xl">
    <PageHeader title="Thinking" description="How reasoning effort and thinking budgets translate between Claude, OpenAI and Gemini.">
      <UButton :loading="saving" :disabled="loading" @click="save">Save changes</UButton>
    </PageHeader>

    <PageLoading v-if="loading" />
    <div v-else class="space-y-6">
      <SettingsCard title="Thinking policy" description="When off, thinking parameters pass through to the upstream unchanged.">
        <template #control><UToggle v-model="settings.enabled" aria-label="Thinking policy" /></template>
        <div class="divide-y divide-gray-100 dark:divide-gray-800 -my-4">
          <div class="flex items-start justify-between gap-6 py-4">
            <div>
              <p class="text-sm font-medium text-gray-900 dark:text-white">Respect the client's request</p>
              <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">Requests without thinking parameters keep the upstream model's default. Explicit client values are never overridden.</p>
            </div>
            <UToggle v-model="settings.respectClient" aria-label="Respect the client's request" class="flex-shrink-0 mt-0.5" />
          </div>
          <div class="flex items-start justify-between gap-6 py-4">
            <div>
              <p class="text-sm font-medium text-gray-900 dark:text-white">Return reasoning summaries</p>
              <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">Include the model's reasoning summary in responses when the upstream provides one.</p>
            </div>
            <UToggle v-model="settings.includeSummary" aria-label="Return reasoning summaries" class="flex-shrink-0 mt-0.5" />
          </div>
          <div class="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div>
              <p class="text-sm font-medium text-gray-900 dark:text-white">Default effort</p>
              <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">Used for requests without thinking parameters. Only applies when the option above is off.</p>
            </div>
            <USelect v-model="settings.defaultEffort" :options="efforts" class="w-full sm:w-40 flex-shrink-0" :disabled="settings.respectClient" />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Effort to token budget" description="An incoming budget maps to the highest effort whose value it reaches. Values must increase from top to bottom.">
        <div class="grid gap-x-5 gap-y-4 grid-cols-2 sm:grid-cols-3">
          <UFormGroup v-for="effort in effortValues" :key="effort" :label="title(effort)">
            <UInput v-model.number="settings.budgetMap[effort]" type="number" min="0" max="1000000" :ui="{ base: 'tabular-nums' }">
              <template #trailing><span class="text-xs text-gray-400 dark:text-gray-500">tokens</span></template>
            </UInput>
          </UFormGroup>
        </div>
        <div class="mt-5 flex flex-wrap items-center gap-2 rounded-md bg-gray-50 dark:bg-gray-800/50 px-3 py-2.5 text-sm text-gray-600 dark:text-gray-300">
          <span>Try it:</span>
          <USelect v-model="previewEffort" :options="efforts" size="xs" class="w-28" />
          <UIcon name="i-heroicons-arrow-right-20-solid" class="w-4 h-4 text-gray-400" />
          <span class="font-mono tabular-nums text-gray-900 dark:text-white">{{ Number(settings.budgetMap[previewEffort]).toLocaleString() }}</span>
          <span>tokens</span>
        </div>
      </SettingsCard>

      <p class="flex items-start gap-2 text-sm text-gray-500 dark:text-gray-400">
        <UIcon name="i-heroicons-information-circle" class="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span>Claude signatures, redacted thinking and Codex encrypted reasoning are never shown or editable here. They are only passed back to compatible upstream providers.</span>
      </p>
    </div>
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
