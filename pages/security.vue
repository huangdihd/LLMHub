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

onMounted(async () => {
  await loadConfig()
})

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
