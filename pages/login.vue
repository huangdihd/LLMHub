<template>
  <UContainer class="py-16 max-w-md">
    <div class="text-center mb-8">
      <UIcon name="i-heroicons-shield-check" class="w-12 h-12 text-primary mx-auto mb-4" />
      <h2 class="text-2xl font-bold text-gray-900 dark:text-white">
        {{ isSetup ? 'Log In' : 'Set Up Admin Password' }}
      </h2>
      <p class="text-gray-500 dark:text-gray-400 mt-2">
        {{ isSetup ? 'Enter your password to access the dashboard.' : 'Create an admin password to secure LLMHub.' }}
      </p>
    </div>

    <UCard>
      <form @submit.prevent="submit" class="space-y-4">
        <UFormGroup label="Password">
          <UInput
            v-model="password"
            type="password"
            placeholder="Enter password"
            autofocus
            autocomplete="new-password"
          />
        </UFormGroup>

        <UButton type="submit" color="primary" block :loading="loading">
          {{ isSetup ? 'Log In' : 'Set Password' }}
        </UButton>

        <p v-if="error" class="text-sm text-red-500 text-center">{{ error }}</p>
      </form>
    </UCard>
  </UContainer>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const password = ref('')
const error = ref('')
const loading = ref(false)
const isSetup = ref(false)

onMounted(async () => {
  try {
    const res = await $fetch('/api/auth/status')
    isSetup.value = (res as any).initialized
  } catch {}
})

async function submit() {
  error.value = ''
  loading.value = true
  try {
    if (isSetup.value) {
      await $fetch('/api/auth/login', { method: 'POST', body: { password: password.value } })
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
    error.value = e.data?.message || 'Something went wrong.'
  } finally {
    loading.value = false
  }
}
</script>
