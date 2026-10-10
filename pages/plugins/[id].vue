<template>
  <UContainer class="py-8 max-w-5xl">
    <UButton to="/plugins" color="gray" variant="ghost" icon="i-heroicons-arrow-left" class="-ml-2.5 mb-3">Plugins</UButton>

    <UAlert v-if="errorMessage" class="mb-4" color="red" variant="subtle" icon="i-heroicons-x-circle" :title="errorMessage" />

    <div v-if="loading" class="flex justify-center py-16">
      <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 animate-spin text-gray-400" />
    </div>

    <template v-else-if="plugin">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-6">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <h2 class="text-2xl font-bold text-gray-900 dark:text-white">{{ plugin.manifest?.name || plugin.id }}</h2>
            <UBadge :color="plugin.error ? 'red' : plugin.enabled ? 'green' : 'gray'" variant="subtle" size="sm">{{ plugin.error ? 'Error' : plugin.enabled ? 'Enabled' : 'Disabled' }}</UBadge>
            <UBadge v-if="plugin.builtin" color="gray" variant="subtle" size="sm">Built-in</UBadge>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
            <span class="font-mono text-xs">{{ plugin.id }}</span>
            <span>v{{ plugin.manifest?.version || '?' }}</span>
            <span v-if="!plugin.builtin" class="inline-flex items-center gap-1.5 min-w-0">
              <UIcon :name="sourceIcon" class="w-4 h-4 flex-shrink-0" />
              <span class="truncate">{{ sourceLabel }}</span>
            </span>
          </div>
          <p v-if="plugin.manifest?.description" class="mt-3 text-sm text-gray-700 dark:text-gray-300 max-w-2xl">{{ plugin.manifest.description }}</p>
        </div>
        <UButton v-if="!plugin.builtin" class="self-start flex-shrink-0" :color="plugin.enabled ? 'gray' : 'primary'" :variant="plugin.enabled ? 'soft' : 'solid'" :loading="toggling" @click="toggle">{{ plugin.enabled ? 'Disable' : 'Enable' }}</UButton>
      </div>

      <div class="space-y-4">
        <UAlert v-if="plugin.error" color="red" variant="subtle" icon="i-heroicons-x-circle" title="This plugin failed to load" :description="plugin.error" />
        <UAlert v-for="warning in plugin.warnings ?? []" :key="warning" color="amber" variant="subtle" icon="i-heroicons-exclamation-triangle" :title="warning" />

        <UCard v-if="!plugin.builtin">
          <template #header><h3 class="font-medium text-gray-900 dark:text-white">Configuration</h3></template>
          <form v-if="fields.length" class="space-y-5" @submit.prevent="save">
            <PluginSchemaForm ref="schemaForm" v-model="configuration" :fields="fields" editing />
            <div class="flex justify-end">
              <UButton type="submit" :loading="saving" :disabled="!configurationLoaded">Save configuration</UButton>
            </div>
          </form>
          <p v-else class="text-sm text-gray-500 dark:text-gray-400">This plugin has nothing to configure.</p>
        </UCard>

        <UCard>
          <template #header><h3 class="font-medium text-gray-900 dark:text-white">Details</h3></template>
          <dl class="space-y-5 text-sm">
            <div v-if="registrations.length">
              <dt class="text-xs text-gray-500 dark:text-gray-400">Provides</dt>
              <dd class="mt-2 flex flex-wrap gap-1.5"><UBadge v-for="item in registrations" :key="item" color="gray" variant="soft" size="xs">{{ item }}</UBadge></dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 dark:text-gray-400">Plugin API</dt>
              <dd class="mt-1 text-gray-900 dark:text-white">
                <template v-if="plugin.builtin">Ships with LLMHub</template>
                <template v-else-if="plugin.manifest?.engines?.llmhub">Requires <span class="font-mono text-xs">{{ plugin.manifest.engines.llmhub }}</span><span class="text-gray-500 dark:text-gray-400"> · this LLMHub provides {{ plugin.apiVersion || 'an unknown version' }}</span></template>
                <template v-else>Not declared</template>
              </dd>
            </div>
            <div v-if="plugin.dependencies?.length">
              <dt class="text-xs text-gray-500 dark:text-gray-400">Requires</dt>
              <dd class="mt-2">
                <ul class="space-y-1.5">
                  <li v-for="dependency in plugin.dependencies" :key="dependency.id" class="flex items-start gap-2" :class="dependency.satisfied ? 'text-gray-600 dark:text-gray-400' : dependency.optional ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'">
                    <UIcon :name="dependency.satisfied ? 'i-heroicons-check-circle' : 'i-heroicons-exclamation-circle'" class="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span><span class="font-mono text-xs">{{ dependency.id }} {{ dependency.range }}</span><span v-if="dependency.optional"> · optional</span><span v-if="dependency.satisfied && dependency.version"> · v{{ dependency.version }}</span><span v-if="!dependency.satisfied"> — {{ dependency.reason || (dependency.version ? `installed ${dependency.version}` : 'not installed') }}</span></span>
                  </li>
                </ul>
              </dd>
            </div>
            <div v-if="plugin.requiredBy?.length">
              <dt class="text-xs text-gray-500 dark:text-gray-400">Required by</dt>
              <dd class="mt-2 flex flex-wrap gap-1.5">
                <NuxtLink v-for="id in plugin.requiredBy" :key="id" :to="`/plugins/${encodeURIComponent(id)}`" class="font-mono text-xs text-primary-600 dark:text-primary-400 hover:underline">{{ id }}</NuxtLink>
              </dd>
            </div>
          </dl>
        </UCard>

        <UCard v-if="pageURL && plugin.enabled" :ui="{ body: { padding: '' } }">
          <template #header><h3 class="font-medium text-gray-900 dark:text-white">Plugin page</h3></template>
          <!-- Legacy pages retain their asset endpoint; contribution panels use the restricted bridge. -->
          <iframe :src="pageURL" :title="`${plugin.manifest?.name || plugin.id} plugin page`" sandbox="allow-scripts" referrerpolicy="no-referrer" class="w-full min-h-[32rem] rounded-b-lg" />
        </UCard>

        <UCard v-for="panel in detailPanels" :key="panel.id" :ui="{ body: { padding: '' } }">
          <template #header><h3 class="font-medium text-gray-900 dark:text-white">{{ panel.title }}</h3></template>
          <RuntimePluginPanel :plugin-id="plugin.id" :panel="panel" />
        </UCard>
      </div>
    </template>
  </UContainer>
</template>

<script setup lang="ts">
import type { PluginRecord } from '~/shared/types/plugin'
import type { RuntimePanel } from '~/shared/dashboard/plugin-panel'
import { useRuntimePluginContributions } from '~/composables/useRuntimePluginContributions'
const runtime = useRuntimePluginContributions()
const route = useRoute()
const toast = useToast()
type DashboardPlugin = PluginRecord & { apiVersion?: string }
const plugin = ref<DashboardPlugin | null>(null)
const configuration = ref<Record<string, unknown>>({})
const configurationLoaded = ref(false)
const loading = ref(true)
const saving = ref(false)
const toggling = ref(false)
const errorMessage = ref('')
const schemaForm = ref<{ validate: () => boolean } | null>(null)
const fields = computed(() => plugin.value?.manifest?.configSchema || [])
const endpoint = computed(() => `/api/hub/plugins/${encodeURIComponent(String(route.params.id))}`)
const detailPanels = computed<RuntimePanel[]>(() => {
  const record = plugin.value
  if (!record?.enabled || record.error) return []
  return (record.manifest.contributes?.panels || []).filter(panel => panel.location === 'detail')
})
const pageURL = computed(() => {
  const page = plugin.value?.manifest?.ui?.page
  if (!page) return ''
  return `${endpoint.value}/page/${page.split('/').map(encodeURIComponent).join('/')}`
})

const sourceIcon = computed(() => {
  const type = plugin.value?.source?.type
  return type === 'npm' ? 'i-heroicons-cube' : type === 'github' ? 'i-heroicons-code-bracket' : 'i-heroicons-folder'
})
const sourceLabel = computed(() => {
  const source = plugin.value?.source
  if (source?.type === 'npm') return source.packageName || 'npm'
  if (source?.type === 'github') return `${source.owner}/${source.repo}${source.ref ? `#${source.ref}` : ''}`
  return 'Local folder'
})
const registrations = computed(() => {
  const record = plugin.value
  if (!record) return []
  const short = (id: string) => (id.startsWith(`${record.id}:`) ? id.slice(record.id.length + 1) : id)
  return [
    ...record.providers.map(id => `Provider · ${short(id)}`),
    ...(record.ingresses ?? []).map(id => `Ingress · ${short(id)}`),
    ...(record.protocols ?? []).map(id => `Protocol · ${short(id)}`),
    ...record.hooks.map(id => `Hook · ${short(id)}`)
  ]
})
function message(error: unknown, fallback: string) {
  return (error as any)?.data?.message || (error instanceof Error ? error.message : fallback)
}

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
    if (version === loadVersion) errorMessage.value = message(error, 'Unable to load plugin')
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
    errorMessage.value = message(error, 'Unable to save configuration')
  } finally { saving.value = false }
}
async function toggle() {
  const record = plugin.value
  if (!record || record.builtin || toggling.value) return
  toggling.value = true
  errorMessage.value = ''
  try {
    await $fetch<unknown>(`${endpoint.value}/${record.enabled ? 'disable' : 'enable'}`, { method: 'POST' })
    toast.add({ title: `${record.manifest?.name || record.id} ${record.enabled ? 'disabled' : 'enabled'}`, color: 'green', icon: 'i-heroicons-check-circle' })
    await Promise.all([load(), runtime.refresh()])
  } catch (error) {
    errorMessage.value = message(error, 'Plugin operation failed')
  } finally { toggling.value = false }
}
onMounted(load)
watch(() => route.params.id, load)
</script>
