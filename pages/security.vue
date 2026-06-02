<template>
  <UContainer class="py-8 max-w-4xl">
    <div class="mb-6">
      <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Security Settings</h2>
      <p class="text-gray-500 dark:text-gray-400 mt-1">Configure brute-force protection for admin login</p>
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

          <div class="flex justify-end">
            <UButton color="primary" @click="saveConfig" :loading="saving" :disabled="!config.enabled">
              Save Configuration
            </UButton>
          </div>
        </div>
      </UCard>

      <UCard v-if="locked.length > 0">
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
          <div v-for="entry in locked" :key="entry.ip" class="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-800">
            <div>
              <code class="text-sm font-mono text-gray-900 dark:text-white">{{ entry.ip }}</code>
              <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {{ entry.failures }} failed attempt{{ entry.failures !== 1 ? 's' : '' }}
              </div>
            </div>
            <div class="text-sm text-gray-500 dark:text-gray-400">
              Unlocks in {{ formatLockout(entry.locked_until) }}
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
const refreshing = ref(false)

const config = reactive({
  enabled: false,
  max_attempts: 5,
  lockout_minutes: 15,
  ip_header: ''
})

const locked = ref<{ ip: string; failures: number; locked_until: number }[]>([])

onMounted(async () => {
  await loadConfig()
})

async function loadConfig() {
  refreshing.value = true
  try {
    const data = await $fetch('/api/hub/brute-force')
    Object.assign(config, (data as any).config)
    locked.value = (data as any).locked || []
  } catch (e: any) {
    if (e?.statusCode === 401) return navigateTo('/login')
    console.error('Failed to load brute-force config:', e)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

async function saveConfig() {
  saving.value = true
  try {
    await $fetch('/api/hub/brute-force', {
      method: 'PUT',
      body: {
        enabled: config.enabled,
        max_attempts: config.max_attempts,
        lockout_minutes: config.lockout_minutes,
        ip_header: config.ip_header
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
</script>
