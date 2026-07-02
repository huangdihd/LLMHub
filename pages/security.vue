<template>
  <UContainer class="py-8 max-w-4xl">
    <div class="mb-6">
      <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Security Settings</h2>
      <p class="text-gray-500 dark:text-gray-400 mt-1">Configure brute-force protection, SSRF protection, and rate limiting</p>
    </div>

    <div v-if="loading" class="flex justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 animate-spin text-gray-500" />
    </div>

    <template v-else>
      <UCard class="mb-6">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-medium text-gray-900 dark:text-white flex items-center gap-2">
              <UIcon name="i-heroicons-shield-check" class="w-5 h-5 text-primary" />
              Brute-Force Protection
            </h3>
            <UToggle v-model="config.enabled" />
          </div>
        </template>

        <div class="space-y-4">
          <p class="text-sm text-gray-500 dark:text-gray-400">
            Protect admin login from brute-force attacks by temporarily locking out IPs after too many failed attempts.
          </p>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <UFormGroup label="Max Attempts" help="Number of failed attempts before lockout">
              <UInput v-model.number="config.max_attempts" type="number" min="1" max="100" :disabled="!config.enabled" />
            </UFormGroup>

            <UFormGroup label="Lockout Duration (minutes)" help="How long to lock out after max attempts">
              <UInput v-model.number="config.lockout_minutes" type="number" min="1" max="1440" :disabled="!config.enabled" />
            </UFormGroup>
          </div>

          <UFormGroup label="IP Header" help="Leave empty to use direct connection IP. Set if behind a proxy (e.g. X-Forwarded-For)">
            <UInput v-model="config.ip_header" placeholder="e.g. X-Forwarded-For" :disabled="!config.enabled" />
          </UFormGroup>

          <UDivider />

          <div class="flex items-center justify-between">
            <h4 class="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-2">
              <UIcon name="i-heroicons-bolt" class="w-4 h-4 text-primary" />
              API Rate Limiting
            </h4>
            <UToggle v-model="config.rate_limit_enabled" />
          </div>

          <UFormGroup label="Max Requests per Minute" help="Maximum API calls per IP per 60-second window. 0 = unlimited.">
            <UInput v-model.number="config.rate_limit_max_rpm" type="number" min="0" max="10000" :disabled="!config.rate_limit_enabled" />
          </UFormGroup>

          <div class="flex justify-end">
            <UButton color="primary" @click="saveConfig" :loading="saving">
              Save Configuration
            </UButton>
          </div>
        </div>
      </UCard>

      <UCard class="mb-6">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-medium text-gray-900 dark:text-white flex items-center gap-2">
              <UIcon name="i-heroicons-globe-alt" class="w-5 h-5 text-primary" />
              SSRF Protection
            </h3>
            <UToggle v-model="ssrfConfig.enabled" />
          </div>
        </template>

        <div class="space-y-4">
          <p class="text-sm text-gray-500 dark:text-gray-400">
            Prevent Server-Side Request Forgery by restricting provider base URLs to approved domains. Internal/private IPs (localhost, 10.x, 192.168.x, etc.) are always blocked.
          </p>

          <UFormGroup label="Allowed Hosts" help="One hostname per line (e.g. api.openai.com). Leave empty to allow all public hosts.">
            <UTextarea v-model="ssrfAllowedHostsText" :disabled="!ssrfConfig.enabled" placeholder="api.openai.com&#10;api.anthropic.com&#10;generativelanguage.googleapis.com" :rows="4" />
          </UFormGroup>

          <div class="flex justify-end">
            <UButton color="primary" @click="saveSSRFConfig" :loading="savingSSRF">
              Save Configuration
            </UButton>
          </div>
        </div>
      </UCard>

      <UCard class="mb-6">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-medium text-gray-900 dark:text-white flex items-center gap-2">
              <UIcon name="i-heroicons-device-phone-mobile" class="w-5 h-5 text-primary" />
              Two-Factor Authentication (TOTP)
            </h3>
            <UBadge :color="totpEnabled ? 'green' : 'gray'" variant="soft">
              {{ totpEnabled ? 'Enabled' : 'Disabled' }}
            </UBadge>
          </div>
        </template>

        <div class="space-y-4">
          <p class="text-sm text-gray-500 dark:text-gray-400">
            Require a 6-digit code from an authenticator app (Google Authenticator, 1Password, etc.) in addition to the admin password when logging in.
          </p>

          <!-- Not enabled, not in setup -->
          <div v-if="!totpEnabled && !totpSetup">
            <UButton color="primary" :loading="totpLoading" @click="startTotpSetup">
              Enable Two-Factor Auth
            </UButton>
          </div>

          <!-- Setup flow -->
          <div v-else-if="totpSetup" class="space-y-4">
            <div class="flex flex-col sm:flex-row gap-4 items-start">
              <div class="bg-white p-2 rounded-lg w-40 h-40 flex-shrink-0 mx-auto sm:mx-0" v-html="totpSetup.qrSvg" />
              <div class="space-y-2 text-sm min-w-0">
                <p class="text-gray-700 dark:text-gray-300">1. Scan the QR code with your authenticator app, or enter the secret manually:</p>
                <code class="block text-xs font-mono bg-gray-100 dark:bg-gray-800 px-3 py-2 rounded select-all break-all">{{ totpSetup.secret }}</code>
                <p class="text-gray-700 dark:text-gray-300">2. Enter the 6-digit code shown in the app to confirm:</p>
                <div class="flex flex-wrap items-center gap-2">
                  <UInput v-model="totpCode" placeholder="000000" inputmode="numeric" maxlength="6" class="w-28" />
                  <UButton color="primary" :loading="totpLoading" @click="confirmTotpSetup">Confirm</UButton>
                  <UButton color="gray" variant="ghost" @click="cancelTotpSetup">Cancel</UButton>
                </div>
              </div>
            </div>
          </div>

          <!-- Enabled -->
          <div v-else class="space-y-2">
            <p class="text-sm text-gray-700 dark:text-gray-300">To disable, enter a current code from your authenticator app:</p>
            <div class="flex flex-wrap items-center gap-2">
              <UInput v-model="totpCode" placeholder="000000" inputmode="numeric" maxlength="6" class="w-28" />
              <UButton color="red" variant="soft" :loading="totpLoading" @click="disableTotp">Disable Two-Factor Auth</UButton>
            </div>
          </div>
        </div>
      </UCard>

      <UCard v-if="locked.length > 0" class="mb-6">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-medium text-gray-900 dark:text-white flex items-center gap-2">
              <UIcon name="i-heroicons-lock-closed" class="w-5 h-5 text-red-500" />
              Currently Locked IPs
            </h3>
            <UButton color="gray" variant="ghost" size="xs" icon="i-heroicons-arrow-path" :loading="refreshing" @click="loadConfig" />
          </div>
        </template>

        <div class="space-y-3">
          <div v-for="entry in locked" :key="entry.ip" class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-800">
            <div>
              <code class="text-sm font-mono text-gray-900 dark:text-white break-all">{{ entry.ip }}</code>
              <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {{ entry.failures }} / {{ config.max_attempts }} failed attempts
              </div>
            </div>
            <div class="flex items-center gap-3 flex-shrink-0">
              <span class="text-sm text-gray-500 dark:text-gray-400">
                Unlocks in {{ formatLockout(entry.locked_until) }}
              </span>
              <UButton color="red" variant="ghost" size="xs" @click="unlockIp(entry.ip)">
                Unlock
              </UButton>
            </div>
          </div>
        </div>
      </UCard>

      <UCard v-else class="mt-6">
        <div class="text-center py-6 text-gray-500 dark:text-gray-400">
          <UIcon name="i-heroicons-lock-open" class="w-8 h-8 mx-auto mb-2 text-gray-300 dark:text-gray-600" />
          <p class="text-sm">No IPs are currently locked out.</p>
        </div>
      </UCard>
    </template>
  </UContainer>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { renderSVG } from 'uqr'

const toast = useToast()
const loading = ref(true)
const saving = ref(false)
const savingSSRF = ref(false)
const refreshing = ref(false)

const config = reactive({
  enabled: false,
  max_attempts: 5,
  lockout_minutes: 15,
  ip_header: '',
  rate_limit_enabled: false,
  rate_limit_max_rpm: 0
})

const ssrfConfig = reactive({
  enabled: false,
  allowed_hosts: [] as string[]
})

const ssrfAllowedHostsText = ref('')

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
      ip_header: bf.ip_header ?? '',
      rate_limit_enabled: bf.rate_limit_enabled ?? false,
      rate_limit_max_rpm: bf.rate_limit_max_rpm ?? 0
    })
    locked.value = data.locked || []

    const ssrf = data.ssrf || {}
    ssrfConfig.enabled = ssrf.enabled ?? false
    ssrfConfig.allowed_hosts = ssrf.allowed_hosts ?? []
    ssrfAllowedHostsText.value = (ssrf.allowed_hosts || []).join('\n')
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
          rate_limit_enabled: config.rate_limit_enabled,
          rate_limit_max_rpm: config.rate_limit_max_rpm
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

async function saveSSRFConfig() {
  savingSSRF.value = true
  try {
    const hosts = ssrfAllowedHostsText.value
      .split('\n')
      .map(h => h.trim())
      .filter(h => h.length > 0)

    await $fetch('/api/hub/security', {
      method: 'PUT',
      body: {
        ssrf: {
          enabled: ssrfConfig.enabled,
          allowed_hosts: hosts
        }
      }
    })
    ssrfConfig.allowed_hosts = hosts
    toast.add({ title: 'Saved', description: 'SSRF protection updated', icon: 'i-heroicons-check-circle', color: 'green', timeout: 2000 })
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
    toast.add({ title: 'Error', description: 'Failed to save SSRF config', color: 'red' })
  } finally {
    savingSSRF.value = false
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
