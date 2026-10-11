<template>
  <UContainer class="py-8 max-w-5xl">
    <PageHeader title="Updates" description="Keep LLMHub itself up to date. Plugins update from the Plugins page.">
      <UButton v-if="system" color="gray" variant="soft" class="dark:!bg-gray-800 dark:!text-gray-100 dark:hover:!bg-gray-700" icon="i-heroicons-arrow-path" :loading="pending === 'check'" :disabled="busy" @click="checkRelease">Check for updates</UButton>
    </PageHeader>

    <div class="space-y-4">
      <UAlert v-if="connectionError" color="amber" variant="subtle" icon="i-heroicons-arrow-path" title="Reconnecting to LLMHub" :description="connectionError" role="status" />
      <UAlert v-if="actionError" color="red" variant="subtle" icon="i-heroicons-x-circle" :title="actionError" role="alert" />
      <PageLoading v-if="!system && !connectionError" />

      <template v-if="system">
        <UCard>
          <div class="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h3 class="text-lg font-medium text-gray-900 dark:text-white">LLMHub <span class="tabular-nums">{{ system.version }}</span></h3>
                <UBadge :color="status.color" variant="subtle" size="sm">{{ status.label }}</UBadge>
              </div>
              <div class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
                <span>{{ deploymentLabel }}</span>
                <span v-if="system.commit" class="font-mono text-xs" :title="system.commit">{{ system.commit.slice(0, 7) }}</span>
                <span v-if="system.check.checkedAt">Checked {{ formatTime(system.check.checkedAt) }}</span>
              </div>
              <p v-if="system.check.error" class="mt-2 text-sm text-red-600 dark:text-red-400">{{ system.check.error }}</p>
            </div>
            <div v-if="system.check.status === 'available'" class="flex items-center gap-3 flex-shrink-0" aria-live="polite">
              <a v-if="releaseUrl" :href="releaseUrl" target="_blank" rel="noopener noreferrer" class="text-sm text-primary-600 dark:text-primary-400 hover:underline">Release notes</a>
              <UButton v-if="system.canUpdate" :disabled="busy" @click="confirmationOpen = true">Update to {{ system.check.latestVersion }}</UButton>
            </div>
          </div>
        </UCard>

        <UCard v-if="system.update || awaitingUpdate">
          <div class="flex items-start gap-3" aria-live="polite">
            <UIcon :name="progress.icon" class="w-5 h-5 mt-0.5 flex-shrink-0" :class="progress.class" />
            <div class="min-w-0 text-sm">
              <p class="font-medium text-gray-900 dark:text-white">{{ progress.title }}</p>
              <p class="mt-0.5 text-gray-500 dark:text-gray-400">
                <template v-if="system.update?.tag">{{ system.update.tag }}</template>
                <template v-if="system.update?.updatedAt"> · {{ formatTime(system.update.updatedAt) }}</template>
              </p>
              <p v-if="system.update?.error" class="mt-2 text-red-600 dark:text-red-400">{{ system.update.error }}</p>
              <p v-if="updating || awaitingUpdate" class="mt-2 text-gray-500 dark:text-gray-400">This page keeps checking while LLMHub restarts. You can leave and come back.</p>
            </div>
          </div>
        </UCard>

        <SettingsCard v-if="system.command && system.check.status === 'available'" title="How to update" description="This deployment cannot update itself. Run this on the machine LLMHub runs on.">
          <code class="block rounded-md bg-gray-100 dark:bg-gray-800 px-3 py-2 text-xs font-mono text-gray-800 dark:text-gray-200 break-all whitespace-pre-wrap select-all">{{ system.command }}</code>
          <template #footer>
            <UButton color="gray" variant="soft" class="dark:!bg-gray-800 dark:!text-gray-100 dark:hover:!bg-gray-700" :icon="copied ? 'i-heroicons-check' : 'i-heroicons-clipboard-document'" @click="copyCommand">{{ copied ? 'Copied' : 'Copy command' }}</UButton>
          </template>
        </SettingsCard>

        <UCard>
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <h3 class="font-medium text-gray-900 dark:text-white">Check automatically</h3>
              <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">Look for a new release shortly after startup and every six hours. Nothing is installed without you.</p>
            </div>
            <UToggle class="mt-0.5 flex-shrink-0" :model-value="system.automatic" :disabled="busy" aria-label="Check automatically" @update:model-value="saveAutomatic" />
          </div>
        </UCard>
      </template>
    </div>

    <UModal v-model="confirmationOpen" :ui="{ width: 'sm:max-w-lg' }">
      <UCard>
        <template #header><h3 class="font-semibold text-gray-900 dark:text-white">Update to {{ system?.check.latestVersion }}?</h3></template>
        <p class="text-sm text-gray-700 dark:text-gray-300">LLMHub will build the new release, then restart. Requests arriving during the restart will fail, usually for a few seconds. If the new release does not start, the current one is restored automatically.</p>
        <p class="mt-3 text-sm text-gray-500 dark:text-gray-400">Your data is not touched, but it is not backed up either. Back up <span class="font-mono text-xs">.data</span> first if it matters.</p>
        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton color="gray" variant="ghost" @click="confirmationOpen = false">Cancel</UButton>
            <UButton :disabled="busy || !system?.canUpdate || system.check.status !== 'available'" @click="startUpdate">Update and restart</UButton>
          </div>
        </template>
      </UCard>
    </UModal>
  </UContainer>
</template>

<script setup lang="ts">
import type { SystemBuildInformation, SystemUpdateOverview, SystemUpdatePhase } from '~/shared/types/system-update'

const buildInformation = useRuntimeConfig().public.buildInformation as SystemBuildInformation
const system = ref<SystemUpdateOverview | null>(null)
const connectionError = ref('')
const actionError = ref('')
const pending = ref<'check' | 'settings' | 'update' | ''>('')
const awaitingUpdate = ref(false)
const confirmationOpen = ref(false)
const copied = ref(false)
const updating = computed(() => !!system.value?.update && !['completed', 'failed'].includes(system.value.update.phase))
const busy = computed(() => !!pending.value || updating.value || awaitingUpdate.value || !!connectionError.value)
const phases: Record<SystemUpdatePhase, string> = {
  downloading: 'Downloading release', installing: 'Installing dependencies', building: 'Building release',
  switching: 'Switching release', restarting: 'Restarting LLMHub', completed: 'Update completed', failed: 'Update failed'
}
const phaseDescription = computed(() => system.value?.update ? phases[system.value.update.phase] : '')
const status = computed<{ label: string; color: 'green' | 'blue' | 'gray' | 'red' }>(() => {
  const check = system.value?.check
  if (check?.status === 'available') return { label: `${check.latestVersion || check.tag} available`, color: 'blue' }
  if (check?.status === 'current') return { label: 'Up to date', color: 'green' }
  if (check?.status === 'failed') return { label: 'Check failed', color: 'red' }
  if (check?.status === 'no-releases') return { label: 'No releases yet', color: 'gray' }
  return { label: 'Not checked yet', color: 'gray' }
})
const deploymentLabel = computed(() => ({
  service: 'Running as a service', manual: 'Started manually', docker: 'Running in Docker'
} as Record<string, string>)[system.value?.deployment || ''] || 'Development or custom setup')
const progress = computed(() => {
  const phase = system.value?.update?.phase
  if (phase === 'completed') return { title: 'Update completed', icon: 'i-heroicons-check-circle', class: 'text-green-500' }
  if (phase === 'failed') return { title: 'Update failed', icon: 'i-heroicons-x-circle', class: 'text-red-500' }
  return { title: phase ? `${phaseDescription.value}…` : 'Starting the update…', icon: 'i-heroicons-arrow-path', class: 'text-gray-400 animate-spin' }
})
const releaseUrl = computed(() => {
  const value = system.value?.check.releaseUrl
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch { return null }
})

let disposed = false
let overviewRequest = 0
let timer: ReturnType<typeof setTimeout> | undefined
const controller = new AbortController()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.'
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

async function refreshSystem() {
  const request = ++overviewRequest
  try {
    const overview = await $fetch<SystemUpdateOverview>('/api/hub/system', { signal: controller.signal, timeout: 10000, retry: 0 })
    if (disposed || request !== overviewRequest) return
    system.value = overview
    connectionError.value = ''
    // A successful read resolves an uncertain POST without replaying the update request.
    awaitingUpdate.value = false
  } catch (error) {
    if (disposed || request !== overviewRequest) return
    if (typeof error === 'object' && error && 'statusCode' in error && error.statusCode === 401) {
      disposed = true
      await navigateTo({ path: '/login', query: { redirect: '/updates' } })
      return
    }
    connectionError.value = `${errorMessage(error)} Retrying automatically; the host may be restarting.`
  }
}

async function poll() {
  if (disposed) return
  if (!pending.value) await refreshSystem()
  if (!disposed) timer = setTimeout(poll, updating.value || awaitingUpdate.value || connectionError.value ? 3000 : 15000)
}

async function checkRelease() {
  if (busy.value) return
  overviewRequest++
  pending.value = 'check'
  actionError.value = ''
  try {
    await $fetch('/api/hub/system/check', { method: 'POST', body: {}, signal: controller.signal, timeout: 30000, retry: 0 })
    await refreshSystem()
  } catch (error) { if (!disposed) actionError.value = errorMessage(error) }
  finally { pending.value = '' }
}

async function saveAutomatic(automatic: boolean) {
  if (busy.value || !system.value) return
  overviewRequest++
  pending.value = 'settings'
  actionError.value = ''
  try {
    await $fetch('/api/hub/system/settings', { method: 'PUT', body: { automatic }, signal: controller.signal, timeout: 10000, retry: 0 })
    await refreshSystem()
  } catch (error) { if (!disposed) actionError.value = errorMessage(error) }
  finally { pending.value = '' }
}

async function startUpdate() {
  if (!confirmationOpen.value || busy.value || !system.value?.canUpdate || system.value.check.status !== 'available') return
  // Ignore reads started before this write: they cannot confirm its outcome.
  overviewRequest++
  confirmationOpen.value = false
  pending.value = 'update'
  awaitingUpdate.value = true
  actionError.value = ''
  try {
    await $fetch('/api/hub/system/update', { method: 'POST', body: {}, signal: controller.signal, timeout: 10000, retry: 0 })
  } catch (error) {
    if (!disposed) actionError.value = `${errorMessage(error)} The host may already have accepted the update. Checking status before allowing another attempt.`
  } finally {
    pending.value = ''
    if (!disposed) await refreshSystem()
  }
}

async function copyCommand() {
  if (!system.value?.command) return
  actionError.value = ''
  try {
    await navigator.clipboard.writeText(system.value.command)
    copied.value = true
  } catch (error) { actionError.value = `Could not copy the command: ${errorMessage(error)} Select and copy it manually.` }
}

onMounted(poll)
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(timer)
  controller.abort()
})
</script>
