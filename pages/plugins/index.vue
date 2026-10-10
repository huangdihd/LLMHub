<template>
  <UContainer class="py-8 max-w-5xl">
    <div class="flex flex-wrap items-center justify-between gap-4 mb-6">
      <div><h2 class="text-2xl font-bold">Plugins</h2><p class="mt-1 text-sm text-gray-500">Manage providers, request hooks, and plugin pages.</p></div>
      <div class="flex gap-2">
        <UButton color="gray" :disabled="busy" @click="scan">Scan plugins</UButton>
        <UButton :loading="busy" @click="upload?.click()">Install / upgrade</UButton>
        <input ref="upload" type="file" accept=".mjs" class="hidden" aria-label="Single-file plugin" @change="install" />
      </div>
    </div>
    <UAlert class="mb-4" color="amber" title="Install only plugins you trust" description="Plugins execute code on the LLMHub server. Review their source before installation." />
    <UAlert v-if="errorMessage" class="mb-4" color="red" :title="errorMessage" />
    <UAlert v-if="installMessage" class="mb-4" color="green" :title="installMessage" />
    <UCard v-if="pendingUpload" class="mb-4">
      <p class="text-sm">Upload “{{ pendingUpload.name }}” was rejected. Review the error above before retrying. Force allows a same-version replacement or downgrade; it does not bypass API or dependency checks.</p>
      <div class="mt-3 flex gap-2">
        <UButton color="amber" :disabled="busy" @click="forceInstall">Force replacement…</UButton>
        <UButton color="gray" :disabled="busy" @click="pendingUpload = null">Cancel</UButton>
      </div>
    </UCard>
    <p v-if="loading" class="py-12 text-center text-gray-500">Loading plugins…</p>
    <UCard v-else-if="!plugins.length"><p class="text-gray-500">No plugins installed. Upload a single .mjs file (up to 1 MiB), or scan the plugins directory.</p></UCard>
    <div v-else class="space-y-4">
      <UCard v-for="plugin in plugins" :key="plugin.id">
        <div class="flex flex-wrap justify-between gap-4">
          <div>
            <span v-if="plugin.builtin" class="text-lg font-medium">{{ plugin.manifest?.name || plugin.id }}</span>
            <NuxtLink v-else :to="`/plugins/${encodeURIComponent(plugin.id)}`" class="text-lg font-medium hover:underline">{{ plugin.manifest?.name || plugin.id }}</NuxtLink>
            <UBadge v-if="plugin.builtin" class="ml-2" color="gray" variant="subtle">Built-in · Read-only</UBadge>
            <UBadge class="ml-2" :color="plugin.error ? 'red' : plugin.enabled ? 'green' : 'gray'" variant="subtle">{{ plugin.status }}</UBadge>
            <p class="text-sm text-gray-500">{{ plugin.id }} · {{ plugin.manifest?.version || 'Unknown version' }}</p>
            <p v-if="plugin.manifest?.description" class="mt-2 text-sm">{{ plugin.manifest?.description }}</p>
            <p class="mt-2 text-xs text-gray-500">Providers: {{ plugin.providers.join(', ') || 'None' }} · Hooks: {{ plugin.hooks.join(', ') || 'None' }}</p>
            <p v-if="plugin.protocols?.length || plugin.ingresses?.length" class="mt-1 text-xs text-gray-500">Protocols: {{ plugin.protocols?.join(', ') || 'None' }} · Ingresses: {{ plugin.ingresses?.join(', ') || 'None' }}</p>
            <p class="mt-2 text-xs text-gray-500">Plugin API: {{ plugin.apiVersion || 'Unknown' }} · Required API: {{ plugin.manifest?.engines?.llmhub || 'Not declared (legacy)' }}</p>
            <ul v-if="plugin.dependencies?.length" class="mt-2 space-y-1 text-sm">
              <li v-for="dependency in plugin.dependencies" :key="dependency.id" :class="dependency.satisfied ? 'text-gray-500' : dependency.optional ? 'text-amber-500' : 'text-red-500'">
                {{ dependency.id }} {{ dependency.range }} · {{ dependency.optional ? 'Optional' : 'Required' }} · {{ dependency.satisfied ? 'Satisfied' : 'Unsatisfied' }} · {{ dependency.version || 'Not installed' }}<span v-if="dependency.reason"> — {{ dependency.reason }}</span>
              </li>
            </ul>
            <p v-if="plugin.requiredBy?.length" class="mt-2 text-sm text-gray-500">Required by: {{ plugin.requiredBy.join(', ') }}</p>
            <ul v-if="plugin.warnings?.length" class="mt-2 text-sm text-amber-500"><li v-for="warning in plugin.warnings" :key="warning">{{ warning }}</li></ul>
            <p v-if="plugin.error" class="mt-2 text-sm text-red-500">{{ plugin.error }}</p>
          </div>
          <div v-if="!plugin.builtin" class="flex flex-wrap items-start gap-2">
            <UButton color="gray" :to="`/plugins/${encodeURIComponent(plugin.id)}`">Configure</UButton>
            <UButton color="gray" :disabled="busy" @click="runAction(plugin.id, plugin.enabled ? 'disable' : 'enable')">{{ plugin.enabled ? 'Disable' : 'Enable' }}</UButton>
            <UButton color="gray" :disabled="busy" @click="runAction(plugin.id, 'reload')">Reload</UButton>
            <UButton color="red" variant="ghost" :disabled="busy" @click="remove(plugin.id)">Uninstall</UButton>
          </div>
        </div>
      </UCard>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import type { PluginRecord } from '~/shared/types/plugin'
type DashboardPlugin = PluginRecord & { apiVersion?: string }
const plugins = ref<DashboardPlugin[]>([])
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const installMessage = ref('')
const pendingUpload = shallowRef<File | null>(null)
const upload = ref<HTMLInputElement | null>(null)
const toast = useToast()

function report(error: unknown) {
  errorMessage.value = (error as any)?.data?.message || (error instanceof Error ? error.message : 'Plugin operation failed')
}
async function load() {
  loading.value = true
  try { plugins.value = await $fetch<DashboardPlugin[]>('/api/hub/plugins') }
  catch (error) { report(error) }
  finally { loading.value = false }
}
async function operate(action: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    await action()
    toast.add({ title: 'Plugin operation completed', color: 'green' })
    await load()
  } catch (error) { report(error) }
  finally { busy.value = false }
}
function runAction(id: string, action: 'enable' | 'disable' | 'reload') {
  return operate(() => $fetch<unknown>(`/api/hub/plugins/${encodeURIComponent(id)}/${action}`, { method: 'POST' }))
}
function scan() {
  return operate(() => $fetch<unknown>('/api/hub/plugins/scan', { method: 'POST' }))
}
function remove(id: string) {
  if (!confirm(`Uninstall plugin “${id}”? Its providers will become unavailable.`)) return
  return operate(() => $fetch<unknown>(`/api/hub/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}
async function uploadPlugin(file: File, force = false) {
  if (busy.value) return
  busy.value = true
  errorMessage.value = ''
  installMessage.value = ''
  pendingUpload.value = null
  const previousVersions = new Map(plugins.value.map(plugin => [plugin.id, plugin.manifest?.version]))
  try {
    const body = new FormData()
    body.append('file', file)
    if (force) body.append('force', 'true')
    const installed = await $fetch<PluginRecord>('/api/hub/plugins/install', { method: 'POST', body })
    const previousVersion = previousVersions.get(installed.id)
    installMessage.value = previousVersion
      ? `${installed.id}: ${previousVersion} → ${installed.manifest.version}${force ? ' (forced replacement)' : ''}`
      : `${installed.id}: installed ${installed.manifest.version}`
    await load()
  } catch (error) {
    report(error)
    pendingUpload.value = file
  } finally { busy.value = false }
}
async function forceInstall() {
  const file = pendingUpload.value
  if (!file || busy.value) return
  if (!confirm(`Force replacement using “${file.name}”? This permits a downgrade or same-version replacement and executes trusted code on the server. Continue only after reviewing the error and source.`)) return
  await uploadPlugin(file, true)
}
async function install(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!file.name.endsWith('.mjs') || file.size > 1024 * 1024) {
    errorMessage.value = 'Choose a single .mjs file up to 1 MiB.'
    input.value = ''
    return
  }
  if (!confirm(`Install or upgrade using “${file.name}”? An existing plugin with the same ID will be upgraded. This plugin can execute code on the server.`)) { input.value = ''; return }
  await uploadPlugin(file)
  input.value = ''
}
onMounted(load)
</script>
