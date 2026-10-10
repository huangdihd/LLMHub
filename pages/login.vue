<template>
  <UContainer class="py-16 sm:py-24 max-w-sm">
    <div class="text-center mb-8">
      <img src="/logo.svg" alt="" class="w-12 h-12 mx-auto mb-5" />
      <h2 class="text-2xl font-bold text-gray-900 dark:text-white">
        {{ isSetup ? 'Log in to LLMHub' : 'Set an admin password' }}
      </h2>
      <p class="text-sm text-gray-500 dark:text-gray-400 mt-2">
        {{ isSetup ? 'Enter the admin password to manage this gateway.' : 'Choose a password to protect this gateway.' }}
      </p>
    </div>

    <UCard>
      <form @submit.prevent="submit" class="space-y-4">
        <UFormGroup label="Password">
          <UInput
            v-model="password"
            type="password"
            size="lg"
            autofocus
            autocomplete="new-password"
          />
        </UFormGroup>

        <UFormGroup v-if="isSetup && totpEnabled" label="Two-factor code">
          <UInput
            v-model="totpCode"
            placeholder="000000"
            size="lg"
            autocomplete="one-time-code"
            inputmode="numeric"
            maxlength="6"
            :ui="{ base: 'font-mono tracking-widest' }"
          />
        </UFormGroup>

        <UAlert v-if="error" color="red" variant="subtle" icon="i-heroicons-x-circle" :title="error" />

        <UButton type="submit" size="lg" block :loading="loading">
          {{ isSetup ? 'Log in' : 'Set password' }}
        </UButton>
      </form>
    </UCard>
  </UContainer>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const password = ref('')
const totpCode = ref('')
const totpEnabled = ref(false)
const error = ref('')
const loading = ref(false)
const isSetup = ref(false)

onMounted(async () => {
  try {
    const res = await $fetch('/api/auth/status')
    isSetup.value = (res as any).initialized
    totpEnabled.value = (res as any).totp_enabled ?? false
  } catch {}
})

async function submit() {
  error.value = ''
  loading.value = true
  try {
    if (isSetup.value) {
      const body: Record<string, string> = { password: password.value }
      if (totpCode.value.trim()) body.totp_code = totpCode.value.trim()
      await $fetch('/api/auth/login', { method: 'POST', body })
    } else {
      await $fetch('/api/auth/setup', { method: 'POST', body: { password: password.value } })
      isSetup.value = true
      // Auto-login after setup
      await $fetch('/api/auth/login', { method: 'POST', body: { password: password.value } })
    }
    // Hard redirect to remount layout and pick up auth state
    const redirect = useRoute().query.redirect as string || '/'
    window.location.href = redirect
  } catch (e: any) {
    if (e?.statusCode === 429) {
      error.value = e.data?.error?.message || e.data?.data?.error?.message || 'Too many attempts. Please try again later.'
    } else {
      error.value = e.data?.message || 'Something went wrong.'
    }
  } finally {
    loading.value = false
  }
}
</script>
