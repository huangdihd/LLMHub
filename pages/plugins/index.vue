<template>
  <UContainer class="py-8 max-w-5xl">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
      <div>
        <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Plugins</h2>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Extend LLMHub with providers, request hooks, and management pages.</p>
      </div>
      <div class="flex flex-wrap items-center gap-2 self-start sm:self-auto">
        <UTooltip text="Rescan the plugins directory">
          <UButton color="gray" variant="ghost" icon="i-heroicons-arrow-path" :loading="scanning" :disabled="busy" aria-label="Rescan the plugins directory" @click="scan" />
        </UTooltip>
        <UButton color="gray" variant="soft" class="dark:!bg-gray-800 dark:!text-gray-100 dark:hover:!bg-gray-700" icon="i-heroicons-code-bracket" :disabled="!githubReady" @click="openGithub">Install from GitHub</UButton>
        <UButton icon="i-heroicons-squares-plus" to="/plugins/market" :disabled="!npmReady">Browse market</UButton>
      </div>
    </div>

    <UAlert v-if="capabilityNotice" class="mb-4" color="amber" variant="subtle" icon="i-heroicons-exclamation-triangle" :title="capabilityNotice.title" :description="capabilityNotice.description" />
    <UAlert v-if="errorMessage" class="mb-4" color="red" variant="subtle" icon="i-heroicons-x-circle" :title="errorMessage" :close-button="{ icon: 'i-heroicons-x-mark-20-solid', color: 'red', variant: 'link' }" @close="errorMessage = ''" />

    <div v-if="loading" class="flex justify-center py-16">
      <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 animate-spin text-gray-400" />
    </div>

    <template v-else>
      <div class="mb-4 inline-flex rounded-lg bg-gray-100 dark:bg-gray-800 p-1 text-sm">
        <button
          v-for="tab in tabs" :key="tab.key" type="button"
          class="px-3 py-1.5 rounded-md font-medium transition-colors"
          :class="activeTab === tab.key ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'"
          @click="activeTab = tab.key"
        >{{ tab.label }} <span class="ml-1 text-xs text-gray-400 dark:text-gray-500">{{ tab.count }}</span></button>
      </div>

      <template v-if="activeTab === 'installed'">
        <UCard v-if="!installed.length" class="text-center">
          <div class="py-10">
            <UIcon name="i-heroicons-puzzle-piece" class="w-10 h-10 mx-auto text-gray-300 dark:text-gray-600" />
            <h3 class="mt-4 font-medium text-gray-900 dark:text-white">No plugins installed</h3>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Find one in the market, install from a GitHub repository, or drop a plugin folder into the plugins directory and rescan.</p>
            <UButton class="mt-5" to="/plugins/market" :disabled="!npmReady">Browse market</UButton>
          </div>
        </UCard>

        <div v-else class="space-y-4">
          <UCard v-for="plugin in installed" :key="plugin.id">
            <div class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <NuxtLink :to="`/plugins/${encodeURIComponent(plugin.id)}`" class="text-lg font-medium text-gray-900 dark:text-white hover:underline">{{ plugin.manifest?.name || plugin.id }}</NuxtLink>
                  <UBadge :color="statusColor(plugin)" variant="subtle" size="sm">{{ statusLabel(plugin) }}</UBadge>
                  <UBadge v-if="updates[plugin.id]?.target" color="blue" variant="subtle" size="sm">Update available</UBadge>
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
                  <span class="font-mono text-xs">{{ plugin.id }}</span>
                  <span>v{{ plugin.manifest?.version || '?' }}</span>
                  <span class="inline-flex items-center gap-1.5 min-w-0">
                    <UIcon :name="sourceIcon(plugin)" class="w-4 h-4 flex-shrink-0" />
                    <span class="truncate">{{ sourceLabel(plugin) }}</span>
                  </span>
                </div>
                <p v-if="plugin.manifest?.description" class="mt-3 text-sm text-gray-700 dark:text-gray-300">{{ plugin.manifest.description }}</p>

                <div v-if="registrations(plugin).length" class="mt-3 flex flex-wrap gap-1.5">
                  <UBadge v-for="item in registrations(plugin)" :key="item" color="gray" variant="soft" size="xs">{{ item }}</UBadge>
                </div>

                <ul v-if="plugin.dependencies?.length" class="mt-3 space-y-1 text-sm">
                  <li v-for="dependency in plugin.dependencies" :key="dependency.id" class="flex items-start gap-2" :class="dependency.satisfied ? 'text-gray-500 dark:text-gray-400' : dependency.optional ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'">
                    <UIcon :name="dependency.satisfied ? 'i-heroicons-check-circle' : 'i-heroicons-exclamation-circle'" class="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>Needs <span class="font-mono text-xs">{{ dependency.id }} {{ dependency.range }}</span><span v-if="dependency.optional"> (optional)</span><span v-if="!dependency.satisfied"> — {{ dependency.reason || (dependency.version ? `installed ${dependency.version}` : 'not installed') }}</span></span>
                  </li>
                </ul>
                <p v-if="plugin.requiredBy?.length" class="mt-2 text-sm text-gray-500 dark:text-gray-400">Required by {{ plugin.requiredBy.join(', ') }}</p>
                <ul v-if="plugin.warnings?.length" class="mt-2 space-y-1 text-sm text-amber-600 dark:text-amber-400">
                  <li v-for="warning in plugin.warnings" :key="warning">{{ warning }}</li>
                </ul>
                <p v-if="plugin.error" class="mt-2 text-sm text-red-600 dark:text-red-400">{{ plugin.error }}</p>

                <div v-if="updates[plugin.id]" class="mt-3 flex flex-wrap items-center gap-3 text-sm">
                  <template v-if="updates[plugin.id].target">
                    <span class="text-gray-700 dark:text-gray-300">{{ updates[plugin.id].summary }}</span>
                    <UButton size="xs" :loading="pending === `update:${plugin.id}`" :disabled="busy" @click="applyUpdate(plugin)">Update</UButton>
                  </template>
                  <span v-else class="text-gray-500 dark:text-gray-400">{{ updates[plugin.id].summary }}</span>
                </div>
              </div>

              <div class="flex items-center gap-2 flex-shrink-0">
                <UButton color="gray" variant="soft" class="dark:!bg-gray-800 dark:!text-gray-100 dark:hover:!bg-gray-700" :loading="pending === `toggle:${plugin.id}`" :disabled="busy" @click="toggle(plugin)">{{ plugin.enabled ? 'Disable' : 'Enable' }}</UButton>
                <UButton color="gray" variant="soft" class="dark:!bg-gray-800 dark:!text-gray-100 dark:hover:!bg-gray-700" icon="i-heroicons-cog-6-tooth" :to="`/plugins/${encodeURIComponent(plugin.id)}`">Configure</UButton>
                <UDropdown :items="menu(plugin)" :popper="{ placement: 'bottom-end' }">
                  <UButton color="gray" variant="ghost" icon="i-heroicons-ellipsis-horizontal" aria-label="More actions" :disabled="busy" />
                </UDropdown>
              </div>
            </div>
          </UCard>
        </div>
      </template>

      <UCard v-else :ui="{ body: { padding: '' } }">
        <ul class="divide-y divide-gray-100 dark:divide-gray-800">
          <li v-for="plugin in builtin" :key="plugin.id" class="px-4 py-3 sm:px-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
              <p class="font-medium text-gray-900 dark:text-white">{{ plugin.manifest?.name || plugin.id }}</p>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400"><span class="font-mono">{{ plugin.id }}</span> · v{{ plugin.manifest?.version }}</p>
            </div>
            <div class="flex flex-wrap gap-1.5 sm:justify-end sm:max-w-md">
              <UBadge v-for="item in registrations(plugin)" :key="item" color="gray" variant="soft" size="xs">{{ item }}</UBadge>
            </div>
          </li>
        </ul>
        <template #footer>
          <p class="text-xs text-gray-500 dark:text-gray-400">Built-in plugins ship with LLMHub. They are always enabled and cannot be removed.</p>
        </template>
      </UCard>
    </template>

    <UModal v-model="githubOpen" :ui="{ width: 'sm:max-w-lg' }">
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-gray-900 dark:text-white">Install from GitHub</h3>
            <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark-20-solid" @click="githubOpen = false" />
          </div>
        </template>
        <form class="space-y-4" @submit.prevent="installGithub">
          <UFormGroup label="Repository" help="owner/repo, or a github.com URL." required>
            <UInput v-model="github.repository" placeholder="owner/repo" autofocus />
          </UFormGroup>
          <UFormGroup label="Tag, branch, or commit" help="Leave empty for the default branch.">
            <UInput v-model="github.ref" placeholder="v1.0.0" />
          </UFormGroup>
          <UAlert color="amber" variant="subtle" icon="i-heroicons-shield-exclamation" title="This runs third-party code" description="The plugin executes on the LLMHub server with the gateway's full privileges. Install only from repositories you trust. The repository must contain a ready-to-load plugin: install scripts are never run." />
          <UAlert v-if="githubError" color="red" variant="subtle" :title="githubError" />
          <div class="flex justify-end gap-2">
            <UButton color="gray" variant="ghost" @click="githubOpen = false">Cancel</UButton>
            <UButton type="submit" :loading="pending === 'github'" :disabled="!github.repository.trim()">Install</UButton>
          </div>
        </form>
      </UCard>
    </UModal>
  </UContainer>
</template>

<script setup lang="ts">
import type { PluginRecord } from '~/shared/types/plugin'

type DashboardPlugin = PluginRecord & { apiVersion?: string }
interface Tool { available: boolean; version?: string; reason?: string }
interface UpdateInfo {
  available: boolean
  currentVersion?: string
  latestVersion?: string | null
  latestMatchingVersion?: string | null
  updates?: Array<{ version: string; ref?: string }>
  reason?: string
  trackedRef?: { ref: string; changed: boolean }
}
interface UpdateState { summary: string; target?: string; specification?: Record<string, string> }

const plugins = ref<DashboardPlugin[]>([])
const capabilities = ref<{ npm: Tool; git: Tool } | null>(null)
const loading = ref(true)
const scanning = ref(false)
const pending = ref('')
const errorMessage = ref('')
const activeTab = ref<'installed' | 'builtin'>('installed')
const updates = ref<Record<string, UpdateState>>({})
const githubOpen = ref(false)
const githubError = ref('')
const github = reactive({ repository: '', ref: '' })
const toast = useToast()

const busy = computed(() => scanning.value || !!pending.value)
const installed = computed(() => plugins.value.filter(plugin => !plugin.builtin))
const builtin = computed(() => plugins.value.filter(plugin => plugin.builtin))
const tabs = computed(() => [
  { key: 'installed' as const, label: 'Installed', count: installed.value.length },
  { key: 'builtin' as const, label: 'Built-in', count: builtin.value.length }
])
const npmReady = computed(() => capabilities.value?.npm.available !== false)
const githubReady = computed(() => npmReady.value && capabilities.value?.git.available !== false)
const capabilityNotice = computed(() => {
  const tools = capabilities.value
  if (!tools) return null
  if (!tools.npm.available) return { title: 'Installing plugins is unavailable on this server', description: tools.npm.reason || 'npm was not found. Plugins placed in the plugins directory still work.' }
  if (!tools.git.available) return { title: 'Installing from GitHub is unavailable on this server', description: tools.git.reason || 'git was not found. The market still works.' }
  return null
})

function message(error: unknown, fallback = 'Plugin operation failed') {
  return (error as any)?.data?.message || (error instanceof Error ? error.message : fallback)
}
function statusLabel(plugin: DashboardPlugin) {
  if (plugin.error) return 'Error'
  return plugin.enabled ? 'Enabled' : 'Disabled'
}
function statusColor(plugin: DashboardPlugin) {
  return plugin.error ? 'red' : plugin.enabled ? 'green' : 'gray'
}
function sourceIcon(plugin: DashboardPlugin) {
  const type = plugin.source?.type
  return type === 'npm' ? 'i-heroicons-cube' : type === 'github' ? 'i-heroicons-code-bracket' : 'i-heroicons-folder'
}
function sourceLabel(plugin: DashboardPlugin) {
  const source = plugin.source
  if (source?.type === 'npm') return source.packageName || 'npm'
  if (source?.type === 'github') return `${source.owner}/${source.repo}${source.ref ? `#${source.ref}` : ''}`
  return 'Local folder'
}
function registrations(plugin: DashboardPlugin) {
  const short = (id: string) => (id.startsWith(`${plugin.id}:`) ? id.slice(plugin.id.length + 1) : id)
  return [
    ...plugin.providers.map(id => `Provider · ${short(id)}`),
    ...(plugin.ingresses ?? []).map(id => `Ingress · ${short(id)}`),
    ...(plugin.protocols ?? []).map(id => `Protocol · ${short(id)}`),
    ...plugin.hooks.map(id => `Hook · ${short(id)}`)
  ]
}

async function load() {
  try { plugins.value = await $fetch<DashboardPlugin[]>('/api/hub/plugins') }
  catch (error) { errorMessage.value = message(error, 'Could not load plugins') }
  finally { loading.value = false }
}
async function run(key: string, action: () => Promise<unknown>, done: string) {
  if (busy.value) return false
  pending.value = key
  errorMessage.value = ''
  try {
    await action()
    await load()
    toast.add({ title: done, color: 'green', icon: 'i-heroicons-check-circle' })
    return true
  } catch (error) {
    errorMessage.value = message(error)
    return false
  } finally { pending.value = '' }
}
function post(id: string, action: string, body?: unknown) {
  return $fetch<unknown>(`/api/hub/plugins/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: body as any })
}
function toggle(plugin: DashboardPlugin) {
  const name = plugin.manifest?.name || plugin.id
  return run(`toggle:${plugin.id}`, () => post(plugin.id, plugin.enabled ? 'disable' : 'enable'), plugin.enabled ? `${name} disabled` : `${name} enabled`)
}
async function scan() {
  if (busy.value) return
  scanning.value = true
  errorMessage.value = ''
  try {
    await $fetch<unknown>('/api/hub/plugins/scan', { method: 'POST' })
    await load()
    toast.add({ title: 'Plugins directory rescanned', color: 'green', icon: 'i-heroicons-check-circle' })
  } catch (error) { errorMessage.value = message(error) }
  finally { scanning.value = false }
}
function uninstall(plugin: DashboardPlugin) {
  const name = plugin.manifest?.name || plugin.id
  if (!confirm(`Uninstall ${name}? Its configuration and stored data are removed, and anything it provides becomes unavailable.`)) return
  return run(`remove:${plugin.id}`, () => $fetch<unknown>(`/api/hub/plugins/${encodeURIComponent(plugin.id)}`, { method: 'DELETE' }), `${name} uninstalled`)
}

async function checkUpdates(plugin: DashboardPlugin) {
  if (busy.value) return
  pending.value = `check:${plugin.id}`
  try {
    const info = await $fetch<UpdateInfo>(`/api/hub/plugins/${encodeURIComponent(plugin.id)}/updates`)
    const current = plugin.manifest?.version
    let state: UpdateState
    if (!info.available) state = { summary: info.reason || 'Could not check for updates.' }
    else if (plugin.source?.type === 'github') {
      const newest = info.updates?.[0]
      if (newest && newest.version !== current) {
        state = { target: newest.version, summary: `v${current} → v${newest.version}`, specification: { owner: plugin.source.owner!, repo: plugin.source.repo!, ref: newest.ref || newest.version } }
      } else if (info.trackedRef?.changed) {
        state = { target: info.trackedRef.ref, summary: `New commits on ${info.trackedRef.ref}` }
      } else state = { summary: 'Up to date.' }
    } else {
      const target = info.latestMatchingVersion || info.latestVersion
      state = target && target !== current
        ? { target, summary: `v${current} → v${target}`, specification: { name: plugin.source?.packageName || '', version: target } }
        : { summary: 'Up to date.' }
    }
    updates.value = { ...updates.value, [plugin.id]: state }
  } catch (error) { errorMessage.value = message(error, 'Could not check for updates') }
  finally { pending.value = '' }
}
async function applyUpdate(plugin: DashboardPlugin) {
  const state = updates.value[plugin.id]
  if (!state?.target) return
  const name = plugin.manifest?.name || plugin.id
  const updated = await run(`update:${plugin.id}`, () => post(plugin.id, 'update', state.specification ? { specification: state.specification } : {}), `${name} updated`)
  if (updated) {
    const { [plugin.id]: _, ...rest } = updates.value
    updates.value = rest
  }
}

function menu(plugin: DashboardPlugin) {
  const packaged = plugin.source?.type === 'npm' || plugin.source?.type === 'github'
  const first: Array<{ label: string; icon: string; click: () => unknown }> = [{ label: 'Reload', icon: 'i-heroicons-arrow-path', click: () => run(`reload:${plugin.id}`, () => post(plugin.id, 'reload'), `${plugin.manifest?.name || plugin.id} reloaded`) }]
  if (packaged && plugin.capabilities?.update !== false) {
    first.push({ label: 'Check for updates', icon: 'i-heroicons-arrow-up-circle', click: () => checkUpdates(plugin) })
  }
  return [first, [{
    label: 'Uninstall', icon: 'i-heroicons-trash',
    disabled: packaged && plugin.capabilities?.uninstall === false,
    click: () => uninstall(plugin)
  }]]
}

function openGithub() {
  github.repository = ''
  github.ref = ''
  githubError.value = ''
  githubOpen.value = true
}
async function installGithub() {
  if (busy.value) return
  const repository = github.repository.trim()
  // Not named `ref`: a local of that name would shadow Vue's auto-imported ref().
  const revision = github.ref.trim()
  const shorthand = repository.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
  const body = shorthand
    ? { owner: shorthand[1], repo: shorthand[2], ...(revision ? { ref: revision } : {}) }
    : revision ? { url: `${repository.replace(/\.git$/, '').replace(/\/+$/, '')}/tree/${revision}` } : { url: repository }
  pending.value = 'github'
  githubError.value = ''
  const before = new Set(plugins.value.map(plugin => plugin.id))
  try {
    await $fetch<unknown>('/api/hub/plugins/install-github', { method: 'POST', body })
    await load()
    githubOpen.value = false
    const added = plugins.value.find(plugin => !before.has(plugin.id))
    toast.add({
      title: added ? `${added.manifest?.name || added.id} installed` : 'Plugin installed',
      description: 'It is disabled until you enable it.', color: 'green', icon: 'i-heroicons-check-circle'
    })
  } catch (error) { githubError.value = message(error, 'Installation failed') }
  finally { pending.value = '' }
}

onMounted(async () => {
  await Promise.all([
    load(),
    $fetch<{ npm: Tool; git: Tool }>('/api/hub/plugins/capabilities').then(value => { capabilities.value = value }).catch(() => {})
  ])
  if (!installed.value.length && builtin.value.length && !npmReady.value) activeTab.value = 'builtin'
})
</script>
