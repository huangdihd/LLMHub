<template>
  <UContainer class="py-8 max-w-5xl">
    <UButton to="/plugins" color="gray" variant="ghost" icon="i-heroicons-arrow-left" class="-ml-2.5 mb-3">Plugins</UButton>

    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
      <div>
        <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Plugin market</h2>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Packages tagged <span class="font-mono text-xs">llmhub-plugin</span> on
          <button type="button" class="underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200" @click="openRegistry">{{ registryHost }}</button>
        </p>
      </div>
    </div>

    <div class="flex flex-col gap-3 sm:flex-row mb-5">
      <UInput v-model="query" class="flex-1" size="lg" icon="i-heroicons-magnifying-glass" placeholder="Search plugins" :ui="{ icon: { trailing: { pointer: '' } } }">
        <template v-if="query" #trailing>
          <UButton color="gray" variant="link" icon="i-heroicons-x-mark-20-solid" :padded="false" aria-label="Clear search" @click="query = ''" />
        </template>
      </UInput>
      <USelect v-model="sort" size="lg" class="sm:w-52" :options="sortOptions" option-attribute="label" value-attribute="value" />
    </div>

    <UAlert color="amber" variant="subtle" icon="i-heroicons-shield-exclamation" class="mb-5" title="Market listings are not reviewed" description="Anyone can publish a package here. A plugin runs on the LLMHub server with the gateway's full privileges, so check the publisher and source before installing." />

    <div v-if="searching && !items.length" class="grid gap-4 sm:grid-cols-2">
      <UCard v-for="index in 4" :key="index">
        <USkeleton class="h-5 w-40" />
        <USkeleton class="mt-3 h-4 w-full" />
        <USkeleton class="mt-2 h-4 w-2/3" />
      </UCard>
    </div>

    <UCard v-else-if="failure" class="text-center">
      <div class="py-10">
        <UIcon :name="failure.unsupported ? 'i-heroicons-magnifying-glass' : 'i-heroicons-signal-slash'" class="w-10 h-10 mx-auto text-gray-300 dark:text-gray-600" />
        <h3 class="mt-4 font-medium text-gray-900 dark:text-white">{{ failure.title }}</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">{{ failure.description }}</p>
        <form v-if="failure.unsupported" class="mt-5 flex justify-center gap-2" @submit.prevent="openByName">
          <UInput v-model="packageName" placeholder="package-name" class="w-64" />
          <UButton type="submit" :disabled="!packageName.trim()">View package</UButton>
        </form>
        <UButton v-else class="mt-5" color="gray" variant="soft" icon="i-heroicons-arrow-path" @click="search">Try again</UButton>
      </div>
    </UCard>

    <UCard v-else-if="!items.length" class="text-center">
      <div class="py-10">
        <UIcon name="i-heroicons-puzzle-piece" class="w-10 h-10 mx-auto text-gray-300 dark:text-gray-600" />
        <h3 class="mt-4 font-medium text-gray-900 dark:text-white">{{ query ? 'No plugins match your search' : 'No plugins published yet' }}</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ query ? 'Try a different search term.' : 'Packages appear here once they are published with the llmhub-plugin keyword.' }}</p>
      </div>
    </UCard>

    <template v-else>
      <div class="grid gap-4 sm:grid-cols-2 transition-opacity" :class="searching ? 'opacity-60' : ''">
        <button
          v-for="item in items" :key="item.name" type="button"
          class="text-left rounded-lg ring-1 ring-gray-200 dark:ring-gray-800 bg-white dark:bg-gray-900 shadow-sm p-5 transition hover:ring-primary-400 dark:hover:ring-primary-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          @click="open(item.name)"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="font-medium text-gray-900 dark:text-white truncate">{{ item.displayName || item.name }}</h3>
              <p v-if="item.displayName && item.displayName !== item.name" class="mt-0.5 font-mono text-xs text-gray-500 dark:text-gray-400 truncate">{{ item.name }}</p>
            </div>
            <UBadge v-if="badge(item)" :color="badge(item)!.color" variant="subtle" size="xs" class="flex-shrink-0">{{ badge(item)!.label }}</UBadge>
          </div>
          <p class="mt-3 text-sm text-gray-700 dark:text-gray-300 line-clamp-2 min-h-[2.5rem]">{{ item.description || 'No description provided.' }}</p>
          <div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
            <span>v{{ item.version }}</span>
            <span v-if="item.publisher || item.author" class="inline-flex items-center gap-1"><UIcon name="i-heroicons-user" class="w-3.5 h-3.5" />{{ item.publisher || item.author }}</span>
            <span v-if="item.date" class="inline-flex items-center gap-1"><UIcon name="i-heroicons-clock" class="w-3.5 h-3.5" />{{ relative(item.date) }}</span>
          </div>
        </button>
      </div>
      <div v-if="total > pageSize" class="mt-6 flex justify-center">
        <UPagination v-model="page" :page-count="pageSize" :total="total" />
      </div>
    </template>

    <USlideover v-model="detailOpen" :ui="{ width: 'w-screen max-w-2xl' }">
      <div class="flex h-full flex-col bg-white dark:bg-gray-900">
        <div class="flex items-start justify-between gap-4 px-6 py-5 border-b border-gray-200 dark:border-gray-800">
          <div class="min-w-0">
            <h3 class="text-lg font-semibold text-gray-900 dark:text-white truncate">{{ detail?.displayName || detail?.name || detailName }}</h3>
            <p v-if="detail?.displayName && detail.displayName !== detail.name" class="mt-0.5 font-mono text-xs text-gray-500 dark:text-gray-400 truncate">{{ detail.name }}</p>
          </div>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark-20-solid" aria-label="Close" @click="detailOpen = false" />
        </div>

        <div v-if="detailLoading" class="flex-1 flex items-center justify-center">
          <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 animate-spin text-gray-400" />
        </div>
        <div v-else-if="detailError" class="flex-1 p-6">
          <UAlert color="red" variant="subtle" icon="i-heroicons-x-circle" :title="detailError" />
        </div>

        <template v-else-if="detail">
          <div class="flex-1 overflow-y-auto px-6 py-5 space-y-6">
            <p v-if="detail.description" class="text-sm text-gray-700 dark:text-gray-300">{{ detail.description }}</p>

            <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div v-if="detail.publisher || detail.author"><dt class="text-xs text-gray-500 dark:text-gray-400">Publisher</dt><dd class="mt-0.5 text-gray-900 dark:text-white truncate">{{ detail.publisher || detail.author }}</dd></div>
              <div v-if="detail.date"><dt class="text-xs text-gray-500 dark:text-gray-400">Last published</dt><dd class="mt-0.5 text-gray-900 dark:text-white">{{ relative(detail.date) }}</dd></div>
              <div v-if="detail.license"><dt class="text-xs text-gray-500 dark:text-gray-400">License</dt><dd class="mt-0.5 text-gray-900 dark:text-white">{{ detail.license }}</dd></div>
              <div v-if="detail.installed"><dt class="text-xs text-gray-500 dark:text-gray-400">Installed</dt><dd class="mt-0.5 text-gray-900 dark:text-white">v{{ detail.installedVersion }}</dd></div>
            </dl>

            <div v-if="links.length" class="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <a v-for="link in links" :key="link.label" :href="link.href" target="_blank" rel="noopener noreferrer nofollow" class="inline-flex items-center gap-1.5 text-primary-600 dark:text-primary-400 hover:underline">
                <UIcon :name="link.icon" class="w-4 h-4" />{{ link.label }}
              </a>
            </div>

            <UAlert v-if="release && compatibility.blocked" color="red" variant="subtle" icon="i-heroicons-no-symbol" title="Not compatible with this LLMHub" :description="compatibility.reason" />
            <UAlert v-else-if="release && compatibility.unknown" color="amber" variant="subtle" icon="i-heroicons-question-mark-circle" title="Compatibility not declared" description="This version does not say which plugin API it targets. It may not work." />

            <div v-if="release?.dependencyStatus?.length">
              <h4 class="text-sm font-medium text-gray-900 dark:text-white">Requires</h4>
              <ul class="mt-2 space-y-1.5 text-sm">
                <li v-for="dependency in release.dependencyStatus" :key="dependency.id" class="flex items-start gap-2" :class="dependency.satisfied ? 'text-gray-600 dark:text-gray-400' : dependency.optional ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'">
                  <UIcon :name="dependency.satisfied ? 'i-heroicons-check-circle' : 'i-heroicons-exclamation-circle'" class="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span><span class="font-mono text-xs">{{ dependency.id }} {{ dependency.range }}</span><span v-if="dependency.builtin"> · built-in</span><span v-if="dependency.optional"> · optional</span><span v-if="!dependency.satisfied"> — {{ dependency.reason || 'not installed' }}</span></span>
                </li>
              </ul>
            </div>

            <div>
              <h4 class="text-sm font-medium text-gray-900 dark:text-white">Readme</h4>
              <PluginReadme v-if="detail.readme" class="mt-3" :source="detail.readme" />
              <p v-else class="mt-2 text-sm text-gray-500 dark:text-gray-400">This package has no readme.</p>
              <p v-if="detail.readmeTruncated" class="mt-3 text-xs text-gray-500 dark:text-gray-400">The readme was shortened. See the package page for the full text.</p>
            </div>
          </div>

          <div class="px-6 py-4 border-t border-gray-200 dark:border-gray-800 space-y-3">
            <UAlert v-if="installError" color="red" variant="subtle" :title="installError" />
            <div v-if="confirming" class="space-y-3">
              <p class="text-sm text-gray-700 dark:text-gray-300">
                Install <span class="font-mono text-xs">{{ detail.name }}@{{ version }}</span>? This is third-party code and will run on the LLMHub server with the gateway's full privileges once you enable it.
              </p>
              <div class="flex justify-end gap-2">
                <UButton color="gray" variant="ghost" :disabled="installing" @click="confirming = false">Cancel</UButton>
                <UButton :loading="installing" @click="install">{{ action.confirm }}</UButton>
              </div>
            </div>
            <div v-else class="flex items-center justify-between gap-3">
              <USelect v-model="version" class="w-40" :options="versionOptions" />
              <div class="flex items-center gap-3">
                <NuxtLink v-if="detail.installed && detail.pluginId" :to="`/plugins/${encodeURIComponent(detail.pluginId)}`" class="text-sm text-primary-600 dark:text-primary-400 hover:underline">Configure</NuxtLink>
                <UButton :color="action.disabled ? 'gray' : 'primary'" :variant="action.disabled ? 'soft' : 'solid'" :disabled="action.disabled" @click="confirming = true; installError = ''">{{ action.label }}</UButton>
              </div>
            </div>
          </div>
        </template>
      </div>
    </USlideover>

    <UModal v-model="registryOpen" :ui="{ width: 'sm:max-w-lg' }">
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-gray-900 dark:text-white">Registry</h3>
            <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark-20-solid" @click="registryOpen = false" />
          </div>
        </template>
        <form class="space-y-4" @submit.prevent="saveRegistry">
          <UFormGroup label="Registry URL" help="The npm registry the market searches and installs from. Use a private registry or a mirror if you have one.">
            <UInput v-model="registryDraft" placeholder="https://registry.npmjs.org/" />
          </UFormGroup>
          <UAlert v-if="registryError" color="red" variant="subtle" :title="registryError" />
          <div class="flex items-center justify-between gap-2">
            <UButton color="gray" variant="link" :padded="false" :disabled="registrySaving" @click="registryDraft = defaultRegistry">Use the default</UButton>
            <div class="flex gap-2">
              <UButton color="gray" variant="ghost" @click="registryOpen = false">Cancel</UButton>
              <UButton type="submit" :loading="registrySaving" :disabled="!registryDraft.trim()">Save</UButton>
            </div>
          </div>
        </form>
      </UCard>
    </UModal>
  </UContainer>
</template>

<script setup lang="ts">
interface MarketItem {
  name: string
  version: string
  description?: string
  author?: string
  license?: string
  date?: string
  links: { npm?: string; homepage?: string; repository?: string; bugs?: string }
  pluginId?: string
  displayName?: string
  publisher?: string
  compatibility: 'compatible' | 'incompatible' | 'unknown'
  compatibilityReason?: string
  installed: boolean
  installedVersion?: string
  updateAvailable: boolean
}
interface DependencyStatus { id: string; range: string; optional: boolean; builtin: boolean; version?: string; satisfied: boolean; reason?: string }
interface Release { version: string; engines?: { llmhub?: string }; dependencyStatus?: DependencyStatus[] }
interface MarketDetail extends MarketItem { readme: string; readmeTruncated: boolean; versions: string[]; releases: Release[]; apiVersion?: string }
interface SearchResult { items: MarketItem[]; total: number; page: number; pageSize: number; registry: string; apiVersion?: string }

const defaultRegistry = 'https://registry.npmjs.org/'
const pageSize = 20
const sortOptions = [
  { label: 'Most relevant', value: 'relevance' },
  { label: 'Most popular', value: 'downloads' },
  { label: 'Recently updated', value: 'updated' },
  { label: 'Name', value: 'name' }
]

const query = ref('')
const sort = ref('relevance')
const page = ref(1)
const items = ref<MarketItem[]>([])
const total = ref(0)
const registry = ref(defaultRegistry)
const apiVersion = ref('')
const searching = ref(true)
const failure = ref<{ title: string; description: string; unsupported: boolean } | null>(null)
const packageName = ref('')

const detailOpen = ref(false)
const detailName = ref('')
const detail = ref<MarketDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
const version = ref('')
const confirming = ref(false)
const installing = ref(false)
const installError = ref('')

const registryOpen = ref(false)
const registryDraft = ref('')
const registryError = ref('')
const registrySaving = ref(false)
const toast = useToast()

const registryHost = computed(() => {
  try { return new URL(registry.value).host } catch { return registry.value }
})
const versionOptions = computed(() => {
  const versions = [...(detail.value?.versions ?? [])].reverse()
  const latest = detail.value?.version
  return latest && versions.includes(latest) ? [latest, ...versions.filter(candidate => candidate !== latest)] : versions
})
const release = computed(() => detail.value?.releases.find(candidate => candidate.version === version.value))
const compatibility = computed(() => {
  const range = release.value?.engines?.llmhub
  if (!range) return { blocked: false, unknown: true, reason: '' }
  // The server judged the latest release; other versions are compared the same way on install.
  const latest = detail.value?.version === version.value
  const blocked = latest && detail.value?.compatibility === 'incompatible'
  return {
    blocked, unknown: false,
    reason: detail.value?.compatibilityReason || `Requires plugin API ${range}; this LLMHub provides ${apiVersion.value || 'a different version'}.`
  }
})
const links = computed(() => {
  const source = detail.value?.links ?? {}
  return [
    source.repository && { label: 'Source', icon: 'i-heroicons-code-bracket', href: source.repository },
    source.homepage && source.homepage !== source.repository && { label: 'Homepage', icon: 'i-heroicons-home', href: source.homepage },
    source.npm && { label: 'Package page', icon: 'i-heroicons-cube', href: source.npm }
  ].filter(Boolean) as Array<{ label: string; icon: string; href: string }>
})
const action = computed(() => {
  const current = detail.value
  const missing = release.value?.dependencyStatus?.some(dependency => !dependency.optional && !dependency.satisfied && !dependency.builtin) ?? false
  if (!current || !version.value) return { label: 'Install', confirm: 'Install', disabled: true }
  if (compatibility.value.blocked) return { label: 'Not compatible', confirm: 'Install', disabled: true }
  if (current.installed && current.installedVersion === version.value) return { label: 'Installed', confirm: 'Install', disabled: true }
  if (current.installed) return { label: `Change to v${version.value}`, confirm: 'Change version', disabled: false }
  return { label: missing ? 'Install anyway' : 'Install', confirm: 'Install', disabled: false }
})

function message(error: unknown, fallback: string) {
  return (error as any)?.data?.message || (error instanceof Error ? error.message : fallback)
}
function code(error: unknown) {
  return (error as any)?.data?.data?.code || (error as any)?.data?.code
}
function relative(date: string) {
  const elapsed = Date.now() - new Date(date).getTime()
  if (!Number.isFinite(elapsed)) return ''
  const days = Math.floor(elapsed / 86_400_000)
  if (days < 1) return 'today'
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  if (days < 365) { const months = Math.floor(days / 30); return `${months} month${months === 1 ? '' : 's'} ago` }
  const years = Math.floor(days / 365)
  return `${years} year${years === 1 ? '' : 's'} ago`
}
function badge(item: MarketItem): { label: string; color: 'green' | 'blue' | 'red' } | null {
  if (item.updateAvailable) return { label: 'Update available', color: 'blue' }
  if (item.installed) return { label: 'Installed', color: 'green' }
  if (item.compatibility === 'incompatible') return { label: 'Not compatible', color: 'red' }
  return null
}

let request = 0
async function search() {
  const current = ++request
  searching.value = true
  try {
    const result = await $fetch<SearchResult>('/api/hub/plugins/market', {
      query: { query: query.value.trim() || undefined, page: page.value, pageSize, sort: sort.value }
    })
    if (current !== request) return
    items.value = result.items
    total.value = result.total
    registry.value = result.registry
    apiVersion.value = result.apiVersion || ''
    failure.value = null
  } catch (error) {
    if (current !== request) return
    items.value = []
    total.value = 0
    const unsupported = code(error) === 'SEARCH_UNSUPPORTED'
    failure.value = unsupported
      ? { unsupported, title: 'This registry does not support search', description: 'You can still install a plugin from it if you know the package name.' }
      : { unsupported, title: 'The market is unavailable', description: message(error, 'The registry could not be reached.') }
  } finally {
    if (current === request) searching.value = false
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined
watch(query, () => {
  clearTimeout(debounce)
  debounce = setTimeout(() => { if (page.value === 1) search(); else page.value = 1 }, 300)
})
watch(sort, () => { if (page.value === 1) search(); else page.value = 1 })
watch(page, search)

async function open(name: string) {
  detailName.value = name
  detail.value = null
  detailError.value = ''
  installError.value = ''
  confirming.value = false
  detailOpen.value = true
  detailLoading.value = true
  try {
    const result = await $fetch<MarketDetail>('/api/hub/plugins/market/detail', { query: { name } })
    if (detailName.value !== name) return
    detail.value = result
    apiVersion.value = result.apiVersion || apiVersion.value
    version.value = result.version
  } catch (error) {
    if (detailName.value === name) detailError.value = code(error) === 'PACKAGE_NOT_FOUND' ? `No package named “${name}” on this registry.` : message(error, 'Could not load this package.')
  } finally {
    if (detailName.value === name) detailLoading.value = false
  }
}
function openByName() {
  const name = packageName.value.trim()
  if (name) open(name)
}
async function install() {
  const current = detail.value
  if (!current || installing.value) return
  installing.value = true
  installError.value = ''
  try {
    await $fetch<unknown>('/api/hub/plugins/install-npm', {
      method: 'POST',
      body: { name: current.name, version: version.value, ...(current.installed ? { force: true } : {}) }
    })
    toast.add({
      title: `${current.displayName || current.name} v${version.value} installed`,
      description: current.installed ? undefined : 'It is disabled until you enable it on the Plugins page.',
      color: 'green', icon: 'i-heroicons-check-circle'
    })
    confirming.value = false
    await Promise.all([open(current.name), search()])
  } catch (error) {
    installError.value = message(error, 'Installation failed')
    confirming.value = false
  } finally { installing.value = false }
}

function openRegistry() {
  registryDraft.value = registry.value
  registryError.value = ''
  registryOpen.value = true
}
async function saveRegistry() {
  registrySaving.value = true
  registryError.value = ''
  try {
    const saved = await $fetch<{ registry: string }>('/api/hub/plugins/registry', { method: 'PUT', body: { registry: registryDraft.value.trim() } })
    registry.value = saved.registry
    registryOpen.value = false
    if (page.value === 1) await search(); else page.value = 1
  } catch (error) { registryError.value = message(error, 'Could not save the registry') }
  finally { registrySaving.value = false }
}

onMounted(async () => {
  $fetch<{ registry: string }>('/api/hub/plugins/registry').then(value => { registry.value = value.registry }).catch(() => {})
  await search()
})
</script>
