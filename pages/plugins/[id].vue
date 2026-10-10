<template>
  <UContainer class="py-8 max-w-5xl space-y-6">
    <UButton to="/plugins" color="gray" variant="ghost" icon="i-heroicons-arrow-left">Plugins</UButton>
    <UAlert v-if="errorMessage" color="red" :title="errorMessage" />
    <p v-if="loading" class="text-gray-500">Loading plugin…</p>
    <template v-else-if="plugin">
      <div>
        <h2 class="text-2xl font-bold">{{ plugin.manifest?.name || plugin.id }}</h2>
        <p class="mt-1 text-sm text-gray-500">{{ plugin.id }} · {{ plugin.manifest?.version || 'Unknown version' }} · {{ plugin.status }}</p>
        <p class="mt-2 text-sm text-gray-500">Plugin API: {{ plugin.apiVersion || 'Unknown' }} · Required API: {{ plugin.manifest?.engines?.llmhub || 'Not declared (legacy)' }}</p>
        <ul v-if="plugin.dependencies?.length" class="mt-3 space-y-1 text-sm">
          <li v-for="dependency in plugin.dependencies" :key="dependency.id" :class="dependency.satisfied ? 'text-gray-500' : dependency.optional ? 'text-amber-500' : 'text-red-500'">
            {{ dependency.id }} {{ dependency.range }} · {{ dependency.optional ? 'Optional' : 'Required' }} · {{ dependency.satisfied ? 'Satisfied' : 'Unsatisfied' }} · {{ dependency.version || 'Not installed' }}<span v-if="dependency.reason"> — {{ dependency.reason }}</span>
          </li>
        </ul>
        <p v-if="plugin.requiredBy?.length" class="mt-2 text-sm text-gray-500">Required by: {{ plugin.requiredBy.join(', ') }}</p>
        <ul v-if="plugin.warnings?.length" class="mt-2 text-sm text-amber-500"><li v-for="warning in plugin.warnings" :key="warning">{{ warning }}</li></ul>
        <p v-if="plugin.error" class="mt-2 text-sm text-red-500">{{ plugin.error }}</p>
      </div>
      <UAlert v-if="plugin.builtin" color="blue" title="Built-in plugin" description="Always enabled. Built-in plugins cannot be configured, disabled, reloaded, or removed here." />
      <UCard v-else>
        <template #header><h3 class="font-medium">Configuration</h3></template>
        <form class="space-y-5" @submit.prevent="save">
          <PluginSchemaForm v-if="fields.length" ref="schemaForm" v-model="configuration" :fields="fields" editing />
          <p v-else class="text-sm text-gray-500">This plugin has no configuration fields.</p>
          <UButton v-if="fields.length" type="submit" :loading="saving" :disabled="!configurationLoaded">Save configuration</UButton>
        </form>
      </UCard>
      <UCard v-if="pageURL && plugin.enabled">
        <template #header><h3 class="font-medium">Plugin page</h3></template>
        <!-- Scripts may run, but the plugin cannot access the dashboard's origin or parent DOM. -->
        <iframe :src="pageURL" :title="`${plugin.manifest?.name || plugin.id} plugin page`" sandbox="allow-scripts" referrerpolicy="no-referrer" class="w-full min-h-[32rem] rounded-md border border-gray-200 dark:border-gray-700" />
      </UCard>
    </template>
  </UContainer>
</template>

<script setup lang="ts">
import type { PluginRecord } from '~/shared/types/plugin'
const route = useRoute()
const toast = useToast()
type DashboardPlugin = PluginRecord & { apiVersion?: string }
const plugin = ref<DashboardPlugin | null>(null)
const configuration = ref<Record<string, unknown>>({})
const configurationLoaded = ref(false)
const loading = ref(true)
const saving = ref(false)
const errorMessage = ref('')
const schemaForm = ref<{ validate: () => boolean } | null>(null)
const fields = computed(() => plugin.value?.manifest?.configSchema || [])
const endpoint = computed(() => `/api/hub/plugins/${encodeURIComponent(String(route.params.id))}`)
const pageURL = computed(() => {
  const page = plugin.value?.manifest?.ui?.page
  if (!page) return ''
  return `${endpoint.value}/page/${page.split('/').map(encodeURIComponent).join('/')}`
})

let loadVersion = 0
async function load() {
  const version = ++loadVersion
  const id = String(route.params.id)
  const configurationEndpoint = `${endpoint.value}/config`
  loading.value = true
  errorMessage.value = ''
  plugin.value = null
  configuration.value = {}
  configurationLoaded.value = false
  try {
    const records = await $fetch<DashboardPlugin[]>('/api/hub/plugins')
    if (version !== loadVersion) return
    const record = records.find(item => item.id === id)
    if (!record) throw new Error('Plugin not found')
    plugin.value = record
    const values = !record.builtin && record.manifest?.configSchema?.length
      ? await $fetch<Record<string, unknown>>(configurationEndpoint)
      : {}
    if (version !== loadVersion) return
    // Never echo masked secrets back to the server as replacement values.
    for (const field of record.manifest?.configSchema || []) {
      if (field.type === 'secret') delete values[field.key]
    }
    configuration.value = values
    configurationLoaded.value = true
    plugin.value = record
  } catch (error) {
    if (version === loadVersion) errorMessage.value = error instanceof Error ? error.message : 'Unable to load plugin'
  } finally {
    if (version === loadVersion) loading.value = false
  }
}
async function save() {
  if (plugin.value?.builtin || saving.value || !configurationLoaded.value || !schemaForm.value?.validate()) return
  saving.value = true
  errorMessage.value = ''
  try {
    await $fetch<unknown>(`${endpoint.value}/config`, { method: 'PUT', body: configuration.value })
    toast.add({ title: 'Plugin configuration saved', color: 'green' })
    await load()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Unable to save configuration'
  } finally { saving.value = false }
}
onMounted(load)
watch(() => route.params.id, load)
</script>
