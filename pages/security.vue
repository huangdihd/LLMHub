<template>
  <UContainer class="py-8 max-w-5xl">
    <PageHeader title="Security">
      <template #description>
        <component v-for="section in dashboard.sections('description')" :key="section.id" :is="section.component" v-bind="section.props()" />
      </template>
    </PageHeader>

    <PageLoading v-if="loading" />

    <div v-else class="space-y-6">
      <SettingsCard title="Login protection" description="Temporarily lock out an IP address after too many failed admin logins.">
        <template #control><UToggle v-model="config.enabled" aria-label="Login protection" /></template>

        <div class="space-y-5">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <UFormGroup label="Failed attempts allowed" help="The IP is locked out after this many failures.">
              <UInput v-model.number="config.max_attempts" type="number" min="1" max="100" :disabled="!config.enabled" />
            </UFormGroup>

            <UFormGroup label="Lockout time (minutes)" help="How long the IP stays locked out.">
              <UInput v-model.number="config.lockout_minutes" type="number" min="1" max="1440" :disabled="!config.enabled" />
            </UFormGroup>
          </div>

          <UFormGroup label="Client IP header" help="Set this when LLMHub runs behind a proxy, for example X-Forwarded-For. Leave empty to use the connection's IP.">
            <UInput v-model="config.ip_header" placeholder="X-Forwarded-For" :disabled="!config.enabled" />
          </UFormGroup>

          <component v-for="section in dashboard.sections('login-settings')" :key="section.id" :is="section.component" v-bind="section.props()" />
        </div>

        <template #footer>
          <UButton :loading="saving" @click="saveConfig">Save</UButton>
        </template>
      </SettingsCard>

      <component v-for="section in dashboard.sections('after-login')" :key="section.id" :is="section.component" v-bind="section.props()" />

      <SettingsCard title="Two-factor authentication" description="Ask for a 6-digit code from an authenticator app, in addition to the admin password.">
        <template #control>
          <UBadge :color="totpEnabled ? 'green' : 'gray'" variant="subtle" size="sm">{{ totpEnabled ? 'On' : 'Off' }}</UBadge>
        </template>

        <!-- Not enabled, not in setup -->
        <UButton v-if="!totpEnabled && !totpSetup" :loading="totpLoading" @click="startTotpSetup">Set up two-factor authentication</UButton>

        <!-- Setup flow -->
        <div v-else-if="totpSetup" class="flex flex-col sm:flex-row gap-6 items-start">
          <div class="bg-white p-2 rounded-lg w-40 h-40 flex-shrink-0 mx-auto sm:mx-0" v-html="totpSetup.qrSvg" />
          <ol class="space-y-4 text-sm min-w-0 flex-1">
            <li>
              <p class="text-gray-700 dark:text-gray-300">1. Scan the QR code with your authenticator app, or enter this secret by hand.</p>
              <code class="mt-2 block text-xs font-mono bg-gray-100 dark:bg-gray-800 px-3 py-2 rounded-md select-all break-all">{{ totpSetup.secret }}</code>
            </li>
            <li>
              <p class="text-gray-700 dark:text-gray-300">2. Enter the 6-digit code the app shows.</p>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <UInput v-model="totpCode" placeholder="000000" inputmode="numeric" maxlength="6" class="w-28" :ui="{ base: 'font-mono tracking-widest' }" />
                <UButton :loading="totpLoading" @click="confirmTotpSetup">Turn on</UButton>
                <UButton color="gray" variant="ghost" @click="cancelTotpSetup">Cancel</UButton>
              </div>
            </li>
          </ol>
        </div>

        <!-- Enabled -->
        <div v-else>
          <p class="text-sm text-gray-700 dark:text-gray-300">To turn it off, enter a current code from your authenticator app.</p>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <UInput v-model="totpCode" placeholder="000000" inputmode="numeric" maxlength="6" class="w-28" :ui="{ base: 'font-mono tracking-widest' }" />
            <UButton color="red" variant="soft" :loading="totpLoading" @click="disableTotp">Turn off</UButton>
          </div>
        </div>
      </SettingsCard>

      <UCard :ui="{ body: { padding: '' } }">
        <template #header>
          <div class="flex items-center justify-between gap-4">
            <div>
              <h3 class="font-medium text-gray-900 dark:text-white">Locked-out IP addresses</h3>
              <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">Addresses currently blocked from logging in.</p>
            </div>
            <UButton color="gray" variant="ghost" size="xs" icon="i-heroicons-arrow-path" aria-label="Refresh" :loading="refreshing" @click="loadConfig" />
          </div>
        </template>

        <ul v-if="locked.length > 0" class="divide-y divide-gray-100 dark:divide-gray-800">
          <li v-for="entry in locked" :key="entry.ip" class="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div class="min-w-0">
              <p class="font-mono text-sm text-gray-900 dark:text-white break-all">{{ entry.ip }}</p>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{{ entry.failures }} of {{ config.max_attempts }} failed attempts · unlocks in {{ formatLockout(entry.locked_until) }}</p>
            </div>
            <UButton color="gray" variant="soft" size="xs" class="self-start sm:self-auto dark:!bg-gray-800 dark:!text-gray-100 dark:hover:!bg-gray-700" @click="unlockIp(entry.ip)">Unlock now</UButton>
          </li>
        </ul>
        <EmptyState v-else compact icon="i-heroicons-lock-open" title="No addresses are locked out" />
      </UCard>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { renderSVG } from 'uqr'

const toast = useToast()
const loading = ref(true)
const saving = ref(false)
const dashboard = useDashboardSections('security')
const refreshing = ref(false)

const config = reactive({
  enabled: false,
  max_attempts: 5,
  lockout_minutes: 15,
  ip_header: ''
})

const locked = ref<{ ip: string; failures: number; locked_until: number }[]>([])

const totpEnabled = ref(false)
const totpLoading = ref(false)
const totpCode = ref('')
const totpSetup = ref<{ secret: string; qrSvg: string } | null>(null)

onMounted(async () => {
  await Promise.all([loadConfig(), loadTotpStatus()])
})

async function loadTotpStatus() {
  try {
    const data = await $fetch('/api/hub/totp') as any
    totpEnabled.value = data.enabled ?? false
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
  }
}

async function startTotpSetup() {
  totpLoading.value = true
  try {
    const data = await $fetch('/api/hub/totp/setup', { method: 'POST' }) as any
    totpSetup.value = { secret: data.secret, qrSvg: renderSVG(data.uri) }
    totpCode.value = ''
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
    toast.add({ title: 'Error', description: 'Failed to start TOTP setup', color: 'red' })
  } finally {
    totpLoading.value = false
  }
}

function cancelTotpSetup() {
  totpSetup.value = null
  totpCode.value = ''
}

async function confirmTotpSetup() {
  totpLoading.value = true
  try {
    await $fetch('/api/hub/totp/enable', { method: 'POST', body: { code: totpCode.value.trim() } })
    totpEnabled.value = true
    totpSetup.value = null
    totpCode.value = ''
    toast.add({ title: 'Two-factor auth enabled', icon: 'i-heroicons-check-circle', color: 'green', timeout: 2000 })
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
    toast.add({ title: 'Invalid code', description: 'Check your authenticator app and try again', color: 'red' })
  } finally {
    totpLoading.value = false
  }
}

async function disableTotp() {
  totpLoading.value = true
  try {
    await $fetch('/api/hub/totp/disable', { method: 'POST', body: { code: totpCode.value.trim() } })
    totpEnabled.value = false
    totpCode.value = ''
    toast.add({ title: 'Two-factor auth disabled', icon: 'i-heroicons-check-circle', color: 'green', timeout: 2000 })
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
    toast.add({ title: 'Invalid code', description: 'Check your authenticator app and try again', color: 'red' })
  } finally {
    totpLoading.value = false
  }
}

async function loadConfig() {
  refreshing.value = true
  try {
    const data = await $fetch('/api/hub/security') as any
    const bf = data.bruteForce || {}
    Object.assign(config, {
      enabled: bf.enabled ?? false,
      max_attempts: bf.max_attempts ?? 5,
      lockout_minutes: bf.lockout_minutes ?? 15,
      ip_header: bf.ip_header ?? ''
    })
    locked.value = data.locked || []

    dashboard.hydrate(data)
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
    console.error('Failed to load security config:', e)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

async function saveConfig() {
  saving.value = true
  try {
    await $fetch('/api/hub/security', {
      method: 'PUT',
      body: {
        bruteForce: {
          enabled: config.enabled,
          max_attempts: config.max_attempts,
          lockout_minutes: config.lockout_minutes,
          ip_header: config.ip_header,
          ...dashboard.payload()
        }
      }
    })
    toast.add({ title: 'Saved', description: 'Brute-force protection updated', icon: 'i-heroicons-check-circle', color: 'green', timeout: 2000 })
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
    toast.add({ title: 'Error', description: 'Failed to save config', color: 'red' })
  } finally {
    saving.value = false
  }
}

function formatLockout(until: number): string {
  const remaining = until - Date.now()
  if (remaining <= 0) return 'soon'
  const minutes = Math.ceil(remaining / 60000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

async function unlockIp(ip: string) {
  try {
    await $fetch(`/api/hub/brute-force/${ip}`, { method: 'DELETE' })
    await loadConfig()
    toast.add({ title: 'Unlocked', description: `IP ${ip} has been unlocked`, icon: 'i-heroicons-check-circle', color: 'green', timeout: 2000 })
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
    toast.add({ title: 'Error', description: 'Failed to unlock IP', color: 'red' })
  }
}
</script>
